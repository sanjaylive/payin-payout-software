import { Inject, Injectable } from '@nestjs/common';
import { buildTotpUri, FieldEncryptor, generateTotpSecret, newId, verifyPassword, verifyTotp } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import QRCode from 'qrcode';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';
import { SessionService } from './session.service';

/** TOTP enrollment and verification (docs/SECURITY.md §1.5). Secrets are stored encrypted with AAD = user id. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly sessions: SessionService,
    private readonly profiles: AccessProfileService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  async status(userId: string) {
    const active = await this.prisma.mfaFactor.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { confirmedAt: true },
    });
    return { enabled: Boolean(active), confirmedAt: active?.confirmedAt ?? null };
  }

  /** Start enrollment. Returns the secret/QR exactly once; a previous pending enrollment is discarded. */
  async setup(actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } });
    if ((await this.status(actor.userId)).enabled) {
      throw new AppError(ErrorCode.CONFLICT, 'Two-factor authentication is already enabled');
    }
    const secret = generateTotpSecret();
    await this.prisma.$transaction(async (tx) => {
      await tx.mfaFactor.updateMany({
        where: { userId: actor.userId, status: 'PENDING' },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });
      await tx.mfaFactor.create({
        data: {
          id: newId('mfaFactor'),
          userId: actor.userId,
          type: 'TOTP',
          status: 'PENDING',
          secretEncrypted: this.encryptor.encrypt(secret, actor.userId),
        },
      });
    });
    const otpauthUrl = buildTotpUri(secret, user.email);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
  }

  /** Confirm enrollment with a valid code; lifts a restricted session. */
  async enable(actor: Actor, code: string) {
    const pending = await this.prisma.mfaFactor.findFirst({
      where: { userId: actor.userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) throw new AppError(ErrorCode.INVALID_REQUEST, 'Start two-factor setup first');

    const secret = this.encryptor.decrypt(pending.secretEncrypted, actor.userId);
    const result = await verifyTotp(secret, code);
    if (!result.valid) throw new AppError(ErrorCode.MFA_INVALID_CODE);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const activated = await tx.mfaFactor.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'ACTIVE', confirmedAt: now, lastUsedStep: result.timeStep ?? null },
      });
      if (activated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Enrollment changed, please retry');
      await tx.session.update({
        where: { id: actor.sessionId },
        data: { mfaVerifiedAt: now, mfaEnrollmentRequired: false },
      });
      await this.audit.record({ action: 'auth.mfa.enabled', resourceType: 'user', resourceId: actor.userId }, tx);
    });
    return this.sessions.reissueAccessToken(actor.sessionId);
  }

  /** Verify a login code for the user's ACTIVE factor, atomically advancing the replay watermark. */
  async verifyForLogin(userId: string, code: string): Promise<boolean> {
    const factor = await this.prisma.mfaFactor.findFirst({ where: { userId, status: 'ACTIVE' } });
    if (!factor) return false;
    const result = await verifyTotp(this.encryptor.decrypt(factor.secretEncrypted, userId), code, factor.lastUsedStep);
    if (!result.valid || result.timeStep === undefined) return false;
    // Conditional update prevents two concurrent requests both using the same code.
    const advanced = await this.prisma.mfaFactor.updateMany({
      where: {
        id: factor.id,
        status: 'ACTIVE',
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: result.timeStep } }],
      },
      data: { lastUsedStep: result.timeStep },
    });
    return advanced.count === 1;
  }

  async disable(actor: Actor, code: string, password: string): Promise<void> {
    const profile = await this.profiles.load(actor.userId, actor.organizationId);
    if (this.config.env.AUTH_ENFORCE_MFA && profile?.requiresMfa) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Two-factor authentication is mandatory for your role');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(user.passwordHash, password))) throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    if (!(await this.verifyForLogin(actor.userId, code))) throw new AppError(ErrorCode.MFA_INVALID_CODE);

    await this.prisma.$transaction(async (tx) => {
      await tx.mfaFactor.updateMany({
        where: { userId: actor.userId, status: 'ACTIVE' },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });
      await this.audit.record({ action: 'auth.mfa.disabled', resourceType: 'user', resourceId: actor.userId }, tx);
    });
  }
}
