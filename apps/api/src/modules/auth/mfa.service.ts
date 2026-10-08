import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { buildTotpUri, FieldEncryptor, generateTotpSecret, newId, verifyPassword, verifyTotp } from '@pay2all/auth';
import type { DbClient } from '@pay2all/database';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import QRCode from 'qrcode';
import { AppError } from '../../common/errors/app-error';
import { NotificationsService } from '../../infra/notifications.service';
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
    private readonly notifications: NotificationsService,
  ) {}

  // ---- Recovery codes -------------------------------------------------------------------------

  private static readonly RECOVERY_CODE_COUNT = 10;
  private static readonly ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  private hashRecoveryCode(code: string): string {
    // Keyed hash: a leaked table alone can't be brute-forced offline (50-bit codes).
    return this.encryptor.blindIndex(code.toUpperCase(), 'mfa-recovery-code');
  }

  /** Replace all recovery codes for a user; returns the plaintext codes exactly once. */
  async issueRecoveryCodes(db: DbClient, userId: string): Promise<string[]> {
    const codes = Array.from({ length: MfaService.RECOVERY_CODE_COUNT }, () => {
      const chars = Array.from({ length: 10 }, () => MfaService.ALPHABET[randomInt(MfaService.ALPHABET.length)]).join('');
      return `${chars.slice(0, 5)}-${chars.slice(5)}`;
    });
    await db.mfaRecoveryCode.deleteMany({ where: { userId } });
    await db.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ id: newId('recoveryCode'), userId, codeHash: this.hashRecoveryCode(code) })),
    });
    return codes;
  }

  /** Consume a recovery code (single use, race-safe) as the second factor. */
  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const used = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: this.hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) return false;
    const remaining = await this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
    await this.audit.record({ action: 'auth.mfa.recovery_code_used', resourceType: 'user', resourceId: userId, organizationId: null, actor: { type: 'USER', id: userId }, metadata: { remaining, severity: 'MEDIUM' } });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user) {
      await this.notifications.queue(this.prisma, {
        template: 'mfa_recovery_code_used',
        to: user.email,
        subject: 'A {{short}} recovery code was used',
        text: `A recovery code was just used to sign in to your account. ${remaining} codes remain. If this wasn't you, reset your password and contact support immediately.`,
      });
    }
    return true;
  }

  /** Needs a current authenticator code, or (passkey users) a recent step-up checked by the caller. */
  async regenerateRecoveryCodes(actor: Actor, proof: { code: string } | { steppedUp: true }): Promise<string[]> {
    if ((await this.prisma.mfaFactor.count({ where: { userId: actor.userId, status: 'ACTIVE' } })) === 0) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Turn on two-factor authentication first');
    }
    if ('code' in proof && !(await this.verifyForLogin(actor.userId, proof.code))) throw new AppError(ErrorCode.MFA_INVALID_CODE);
    return this.prisma.$transaction(async (tx) => {
      const codes = await this.issueRecoveryCodes(tx, actor.userId);
      await this.audit.record({ action: 'auth.mfa.recovery_codes_regenerated', resourceType: 'user', resourceId: actor.userId }, tx);
      return codes;
    });
  }

  /**
   * Platform-staff reset for a user who lost their authenticator and recovery codes. Disables all
   * factors and codes and signs the user out everywhere; they must re-enroll at next sign-in.
   */
  async adminReset(actor: Actor, userId: string, reason: string): Promise<void> {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    if (actor.userId === userId) throw new AppError(ErrorCode.FORBIDDEN, 'You cannot reset your own two-factor authentication');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.mfaFactor.updateMany({ where: { userId, status: { in: ['ACTIVE', 'PENDING'] } }, data: { status: 'DISABLED', disabledAt: new Date() } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await this.audit.record({ action: 'auth.mfa.admin_reset', resourceType: 'user', resourceId: userId, organizationId: null, metadata: { reason, severity: 'HIGH' } }, tx);
    });
    await this.sessions.revokeAllForUser(userId, 'ADMIN_REVOKED');
    await this.notifications.queue(this.prisma, {
        template: 'mfa_reset_by_admin',
      to: user.email,
      subject: 'Your {{short}} two-factor authentication was reset',
      text: 'An administrator reset two-factor authentication on your account. You will be asked to set it up again at your next sign-in. If you did not request this, contact support immediately.',
    });
  }

  async status(userId: string) {
    const [factors, recoveryCodesRemaining] = await Promise.all([
      this.prisma.mfaFactor.findMany({ where: { userId, status: 'ACTIVE' }, select: { type: true, confirmedAt: true }, orderBy: { confirmedAt: 'asc' } }),
      this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    const totp = factors.find((f) => f.type === 'TOTP');
    return {
      enabled: factors.length > 0,
      confirmedAt: factors[0]?.confirmedAt ?? null,
      totpEnabled: Boolean(totp),
      passkeys: factors.filter((f) => f.type === 'PASSKEY').length,
      recoveryCodesRemaining,
    };
  }

  /** Start enrollment. Returns the secret/QR exactly once; a previous pending enrollment is discarded. */
  async setup(actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } });
    if ((await this.status(actor.userId)).totpEnabled) {
      throw new AppError(ErrorCode.CONFLICT, 'An authenticator app is already set up');
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
      where: { userId: actor.userId, type: 'TOTP', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) throw new AppError(ErrorCode.INVALID_REQUEST, 'Start two-factor setup first');

    const secret = this.encryptor.decrypt(pending.secretEncrypted!, actor.userId);
    const result = await verifyTotp(secret, code);
    if (!result.valid) throw new AppError(ErrorCode.MFA_INVALID_CODE);

    const now = new Date();
    const hadFactor = (await this.prisma.mfaFactor.count({ where: { userId: actor.userId, status: 'ACTIVE' } })) > 0;
    const recoveryCodes = await this.prisma.$transaction(async (tx) => {
      const activated = await tx.mfaFactor.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'ACTIVE', confirmedAt: now, lastUsedStep: result.timeStep ?? null },
      });
      if (activated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Enrollment changed, please retry');
      await tx.session.update({
        where: { id: actor.sessionId },
        data: { mfaVerifiedAt: now, mfaEnrollmentRequired: false, reauthenticatedAt: now },
      });
      await this.audit.record({ action: 'auth.mfa.enabled', resourceType: 'user', resourceId: actor.userId }, tx);
      // A second factor keeps the existing recovery codes; the first one creates them.
      return hadFactor ? null : this.issueRecoveryCodes(tx, actor.userId);
    });
    return { ...(await this.sessions.reissueAccessToken(actor.sessionId)), recoveryCodes };
  }

  /** Verify a login code for the user's ACTIVE factor, atomically advancing the replay watermark. */
  async verifyForLogin(userId: string, code: string): Promise<boolean> {
    const factor = await this.prisma.mfaFactor.findFirst({ where: { userId, type: 'TOTP', status: 'ACTIVE' } });
    if (!factor?.secretEncrypted) return false;
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
    const passkeys = await this.prisma.mfaFactor.count({ where: { userId: actor.userId, type: 'PASSKEY', status: 'ACTIVE' } });
    const profile = await this.profiles.load(actor.userId, actor.organizationId);
    if (!passkeys && this.config.env.AUTH_ENFORCE_MFA && profile?.requiresMfa) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Two-factor authentication is mandatory for your role. Add a passkey before removing the authenticator app.');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(user.passwordHash, password))) throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    if (!(await this.verifyForLogin(actor.userId, code))) throw new AppError(ErrorCode.MFA_INVALID_CODE);

    await this.prisma.$transaction(async (tx) => {
      await tx.mfaFactor.updateMany({
        where: { userId: actor.userId, type: 'TOTP', status: 'ACTIVE' },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });
      if (!passkeys) await tx.mfaRecoveryCode.deleteMany({ where: { userId: actor.userId } });
      await this.audit.record({ action: 'auth.mfa.disabled', resourceType: 'user', resourceId: actor.userId }, tx);
    });
  }
}
