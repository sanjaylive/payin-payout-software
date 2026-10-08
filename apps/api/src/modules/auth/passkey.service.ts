import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

const CHALLENGE_TTL_SECONDS = 300;
const MAX_PASSKEYS = 10;

/** Purposes a challenge is bound to: one challenge can't be replayed for another flow. */
type ChallengePurpose = 'register' | 'login' | 'step-up';

/**
 * WebAuthn passkeys as a second factor (docs/SECURITY.md §1.5). Passkeys are bound to the web app's
 * origin, so a look-alike phishing site can't use them — unlike a 6-digit code. Challenges are random,
 * single-use (Redis GETDEL) and expire after 5 minutes. Only the credential's public key is stored.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly brand: BrandService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly profiles: AccessProfileService,
    private readonly audit: AuditService,
  ) {}

  get rpId(): string {
    return this.config.env.WEBAUTHN_RP_ID || new URL(this.config.env.WEB_PUBLIC_URL).hostname;
  }

  private get origins(): string[] {
    return [...new Set([new URL(this.config.env.WEB_PUBLIC_URL).origin, ...this.config.env.CORS_ALLOWED_ORIGINS])];
  }

  private key(purpose: ChallengePurpose, subject: string) {
    return `webauthn:${purpose}:${subject}`;
  }

  private async takeChallenge(purpose: ChallengePurpose, subject: string): Promise<string> {
    const challenge = await this.redis.getdel(this.key(purpose, subject));
    if (!challenge) throw new AppError(ErrorCode.INVALID_REQUEST, 'The passkey request expired. Try again.');
    return challenge;
  }

  private activePasskeys(userId: string) {
    return this.prisma.mfaFactor.findMany({ where: { userId, type: 'PASSKEY', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  }

  async list(userId: string) {
    const rows = await this.activePasskeys(userId);
    return rows.map((p) => ({ id: p.id, name: p.name, created_at: p.createdAt, last_used_at: p.lastUsedAt, transports: p.transports }));
  }

  // ---- Registration ----------------------------------------------------------------------------

  async registrationOptions(actor: Actor) {
    const [user, existing, brand] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true, name: true } }),
      this.activePasskeys(actor.userId),
      this.brand.get(),
    ]);
    if (existing.length >= MAX_PASSKEYS) throw new AppError(ErrorCode.INVALID_REQUEST, `You can register at most ${MAX_PASSKEYS} passkeys`);
    const options = await generateRegistrationOptions({
      rpName: brand.product_name,
      rpID: this.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(actor.userId),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credentialId!, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    await this.redis.set(this.key('register', actor.sessionId), options.challenge, 'EX', CHALLENGE_TTL_SECONDS);
    return options;
  }

  /**
   * Store a new passkey. As the user's first factor it also lifts an enrollment-restricted session and
   * issues recovery codes (returned once), exactly like enabling an authenticator app.
   */
  async register(actor: Actor, name: string, response: Record<string, unknown>) {
    const expectedChallenge = await this.takeChallenge('register', actor.sessionId);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Passkey registration rejected');
      throw new AppError(ErrorCode.INVALID_REQUEST, 'The passkey could not be verified. Try again.');
    }
    if (!verification.verified) throw new AppError(ErrorCode.INVALID_REQUEST, 'The passkey could not be verified. Try again.');
    const { credential } = verification.registrationInfo;

    const now = new Date();
    const hadFactor = (await this.prisma.mfaFactor.count({ where: { userId: actor.userId, status: 'ACTIVE' } })) > 0;
    const { id, recoveryCodes } = await this.prisma.$transaction(async (tx) => {
      const taken = await tx.mfaFactor.findUnique({ where: { credentialId: credential.id }, select: { id: true } });
      if (taken) throw new AppError(ErrorCode.CONFLICT, 'This passkey is already registered');
      const factor = await tx.mfaFactor.create({
        data: {
          id: newId('mfaFactor'),
          userId: actor.userId,
          type: 'PASSKEY',
          status: 'ACTIVE',
          name,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
          confirmedAt: now,
        },
      });
      await tx.session.update({ where: { id: actor.sessionId }, data: { mfaVerifiedAt: now, mfaEnrollmentRequired: false, reauthenticatedAt: now } });
      await this.audit.record({ action: 'auth.passkey.added', resourceType: 'user', resourceId: actor.userId, metadata: { factor_id: factor.id, name, severity: 'MEDIUM' } }, tx);
      return { id: factor.id, recoveryCodes: hadFactor ? null : await this.mfa.issueRecoveryCodes(tx, actor.userId) };
    });
    const token = actor.restricted ? await this.sessions.reissueAccessToken(actor.sessionId) : null;
    return {
      passkey: { id, name, created_at: now },
      ...(token ? { status: 'AUTHENTICATED', access_token: token.accessToken, token_type: 'Bearer', expires_in: token.expiresIn } : {}),
      ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
    };
  }

  async rename(actor: Actor, id: string, name: string) {
    const updated = await this.prisma.mfaFactor.updateMany({ where: { id, userId: actor.userId, type: 'PASSKEY', status: 'ACTIVE' }, data: { name } });
    if (updated.count !== 1) throw new AppError(ErrorCode.NOT_FOUND, 'Passkey not found');
    return { id, name };
  }

  /** Remove a passkey. The last factor of a role that requires two-factor can't be removed. */
  async remove(actor: Actor, id: string) {
    const factor = await this.prisma.mfaFactor.findFirst({ where: { id, userId: actor.userId, type: 'PASSKEY', status: 'ACTIVE' } });
    if (!factor) throw new AppError(ErrorCode.NOT_FOUND, 'Passkey not found');
    const others = await this.prisma.mfaFactor.count({ where: { userId: actor.userId, status: 'ACTIVE', id: { not: id } } });
    if (!others) {
      const profile = await this.profiles.load(actor.userId, actor.organizationId);
      if (this.config.env.AUTH_ENFORCE_MFA && profile?.requiresMfa) {
        throw new AppError(ErrorCode.FORBIDDEN, 'Two-factor authentication is mandatory for your role. Add another passkey or an authenticator app first.');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.mfaFactor.update({ where: { id }, data: { status: 'DISABLED', disabledAt: new Date() } });
      if (!others) await tx.mfaRecoveryCode.deleteMany({ where: { userId: actor.userId } });
      await this.audit.record({ action: 'auth.passkey.removed', resourceType: 'user', resourceId: actor.userId, metadata: { factor_id: id, name: factor.name, severity: 'MEDIUM' } }, tx);
    });
    return { removed: true };
  }

  // ---- Authentication (login second factor, step-up) ----------------------------------------------

  /** Options for an assertion by one of `userId`'s passkeys, bound to `purpose` + `subject`. */
  async authenticationOptions(userId: string, purpose: 'login' | 'step-up', subject: string) {
    const passkeys = await this.activePasskeys(userId);
    if (!passkeys.length) throw new AppError(ErrorCode.INVALID_REQUEST, 'No passkey is registered for this account');
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId!, transports: p.transports })),
      userVerification: 'preferred',
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    await this.redis.set(this.key(purpose, subject), options.challenge, 'EX', CHALLENGE_TTL_SECONDS);
    return options;
  }

  /**
   * Verify an assertion for `userId`. The challenge is consumed first (single use). The signature
   * counter only moves forward; a non-increasing counter on a counting authenticator means a cloned
   * credential and is rejected.
   */
  async verifyAssertion(userId: string, purpose: 'login' | 'step-up', subject: string, response: Record<string, unknown>): Promise<boolean> {
    const expectedChallenge = await this.takeChallenge(purpose, subject).catch(() => null);
    if (!expectedChallenge) return false;
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const factor = credentialId
      ? await this.prisma.mfaFactor.findFirst({ where: { userId, credentialId, type: 'PASSKEY', status: 'ACTIVE' } })
      : null;
    if (!factor?.publicKey || factor.signCount === null) return false;
    try {
      const result = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        credential: { id: factor.credentialId!, publicKey: new Uint8Array(factor.publicKey), counter: Number(factor.signCount), transports: factor.transports },
        requireUserVerification: false,
      });
      if (!result.verified) return false;
      const moved = await this.prisma.mfaFactor.updateMany({
        where: { id: factor.id, status: 'ACTIVE', signCount: factor.signCount },
        data: { signCount: BigInt(result.authenticationInfo.newCounter), lastUsedAt: new Date() },
      });
      return moved.count === 1;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, factorId: factor.id }, 'Passkey assertion rejected');
      return false;
    }
  }
}
