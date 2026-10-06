import { Inject, Injectable } from '@nestjs/common';
import { checkPasswordPolicy, generateToken, hashPassword, newId, sha256Hex, verifyPassword } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { LoginIdentifier } from '@pay2all/validation';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';
import { maskEmail, RATE_LIMITS } from './auth.util';
import { SessionService } from './session.service';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

@Injectable()
export class PasswordService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly config: ApiConfig,
    private readonly rateLimit: RateLimitService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionService,
    private readonly profiles: AccessProfileService,
    private readonly audit: AuditService,
  ) {}

  /** Always succeeds from the caller's point of view so account existence is never revealed. */
  async requestReset(identifier: LoginIdentifier): Promise<void> {
    const ip = RequestContextStore.get()?.ipAddress ?? 'unknown';
    await this.rateLimit.enforce(RATE_LIMITS.forgotByIp, ip);
    const idLimit = await this.rateLimit.consume(RATE_LIMITS.forgotByIdentifier, sha256Hex(identifier.value));
    if (!idLimit.allowed) return; // silently drop — don't reveal per-account throttling

    const user = await this.prisma.user.findUnique({
      where: identifier.kind === 'email' ? { email: identifier.value } : { mobile: identifier.value },
      select: { id: true, email: true, name: true, status: true },
    });
    if (!user || user.status === 'DISABLED') return;

    const token = await this.issueToken(user.id, RESET_TOKEN_TTL_MS);
    await this.audit.record({
      action: 'auth.password.reset_requested',
      resourceType: 'user',
      resourceId: user.id,
      organizationId: null,
      actor: { type: 'USER', id: user.id },
    });
    await this.notifications.queue(this.prisma, {
        template: 'password_reset',
      to: user.email,
      subject: 'Reset your Pay2All password',
      text: [
        `Hi ${user.name},`,
        '',
        'We received a request to reset your Pay2All Payments password. This link expires in 30 minutes:',
        this.link('/reset-password', token),
        '',
        "If you didn't request this, you can ignore this email — your password won't change.",
      ].join('\n'),
    });
  }

  /** Creates a single-use token (used for both password resets and invitations). Only its hash is stored. */
  async issueToken(userId: string, ttlMs: number): Promise<string> {
    const token = generateToken();
    await this.prisma.passwordResetToken.create({
      data: {
        id: newId('passwordReset'),
        userId,
        tokenHash: sha256Hex(token),
        requestedIp: RequestContextStore.get()?.ipAddress ?? null,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  link(path: string, token: string): string {
    return `${this.config.env.WEB_PUBLIC_URL}${path}?token=${encodeURIComponent(token)}`;
  }

  async reset(token: string, newPassword: string): Promise<void> {
    await this.rateLimit.enforce(RATE_LIMITS.resetByIp, RequestContextStore.get()?.ipAddress ?? 'unknown');
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, usedAt: true, expiresAt: true, user: { select: { id: true, email: true, mobile: true, status: true, passwordHash: true } } },
    });
    if (!record || record.usedAt || record.expiresAt <= new Date() || record.user.status === 'DISABLED') {
      throw new AppError(ErrorCode.INVALID_RESET_TOKEN, 'This link is invalid or has expired');
    }
    const { user } = record;
    await this.assertPolicy(newPassword, user);

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new AppError(ErrorCode.INVALID_RESET_TOKEN, 'This link is invalid or has expired');
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          // Accepting an invitation activates the account.
          ...(user.status === 'INVITED' ? { status: 'ACTIVE', emailVerifiedAt: new Date() } : {}),
        },
      });
      await this.audit.record(
        {
          action: user.status === 'INVITED' ? 'auth.invitation.accepted' : 'auth.password.reset_completed',
          resourceType: 'user',
          resourceId: user.id,
          organizationId: null,
          actor: { type: 'USER', id: user.id },
        },
        tx,
      );
    });
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_RESET');
    await this.profiles.invalidateUser(user.id);
    await this.notifications.queue(this.prisma, {
        template: 'password_changed',
      to: user.email,
      subject: 'Your Pay2All password was changed',
      text: `Your Pay2All Payments password was just set. If this wasn't you, contact support immediately. (${maskEmail(user.email)})`,
    });
  }

  async change(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { id: true, email: true, mobile: true, passwordHash: true },
    });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      await this.audit.record({ action: 'auth.password.change_failed', resourceType: 'user', resourceId: user.id });
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
    }
    await this.assertPolicy(newPassword, user);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
      });
      await this.audit.record({ action: 'auth.password.changed', resourceType: 'user', resourceId: user.id }, tx);
    });
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', actor.sessionId);
  }

  private async assertPolicy(
    password: string,
    user: { email: string; mobile: string | null; passwordHash: string },
  ): Promise<void> {
    const issues = checkPasswordPolicy(password, { email: user.email, mobile: user.mobile });
    if (await verifyPassword(user.passwordHash, password)) issues.push('Must differ from your current password');
    if (issues.length) {
      throw new AppError(
        ErrorCode.PASSWORD_POLICY_VIOLATION,
        'Password does not meet the policy',
        issues.map((message) => ({ path: 'new_password', message })),
      );
    }
  }
}
