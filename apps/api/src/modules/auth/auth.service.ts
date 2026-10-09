import { Inject, Injectable } from '@nestjs/common';
import { getDummyPasswordHash, hashPassword, passwordNeedsRehash, sha256Hex, verifyPassword } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { LoginIdentifier } from '@pay2all/validation';
import type Redis from 'ioredis';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { AuditService } from '../audit/audit.service';
import { LoginEventsService } from '../login-events/login-events.service';
import type { loginLocationSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { maskIdentifier, RATE_LIMITS } from './auth.util';
import { DashboardIpService } from './dashboard-ip.service';
import { type IssuedSession, SessionService } from './session.service';
import { MFA_CHALLENGE_TTL_SECONDS, TokenService } from './token.service';

export type LoginResult =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'mfa_required'; mfaToken: string; expiresIn: number; methods: { totp: boolean; passkey: boolean } };

const MAX_MFA_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly rateLimit: RateLimitService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly profiles: AccessProfileService,
    private readonly audit: AuditService,
    private readonly loginEvents: LoginEventsService,
    private readonly dashboardIp: DashboardIpService,
  ) {}

  async login(identifier: LoginIdentifier, password: string, location?: z.output<typeof loginLocationSchema>): Promise<LoginResult> {
    const ip = RequestContextStore.get()?.ipAddress ?? 'unknown';
    await this.rateLimit.enforce(RATE_LIMITS.loginByIp, ip);
    await this.rateLimit.enforce(RATE_LIMITS.loginByIdentifier, sha256Hex(identifier.value));

    const user = await this.prisma.user.findUnique({
      where: identifier.kind === 'email' ? { email: identifier.value } : { mobile: identifier.value },
      select: { id: true, status: true, passwordHash: true, lockedUntil: true, failedLoginCount: true },
    });

    if (!user) {
      await verifyPassword(await getDummyPasswordHash(), password); // uniform timing
      await this.auditLoginFailure(null, identifier, 'UNKNOWN_USER', location);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.auditLoginFailure(user.id, identifier, 'LOCKED', location);
      throw new AppError(ErrorCode.ACCOUNT_LOCKED);
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.registerFailedAttempt(user.id, identifier, location);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.status === 'DISABLED') {
      await this.auditLoginFailure(user.id, identifier, 'DISABLED', location);
      throw new AppError(ErrorCode.ACCOUNT_DISABLED);
    }
    if (user.status !== 'ACTIVE') {
      // INVITED users have not set a password yet; treat like bad credentials.
      await this.auditLoginFailure(user.id, identifier, 'NOT_ACTIVATED', location);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    const membership = await this.prisma.userRole.findFirst({
      where: { userId: user.id, organization: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!membership) {
      await this.auditLoginFailure(user.id, identifier, 'NO_ACTIVE_ORGANIZATION', location);
      throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'No active organization for this account');
    }

    // Correct password from a network the organization doesn't allow: refuse before any session or
    // second-factor challenge exists. Audited (a real user's password may be in the wrong hands).
    if (!(await this.dashboardIp.isAllowed(membership.organizationId, ip))) {
      await this.loginEvents.record({ userId: user.id, organizationId: membership.organizationId, identifierMasked: maskIdentifier(identifier), outcome: 'IP_NOT_ALLOWED', location });
      await this.audit.record({ action: 'auth.login.ip_blocked', resourceType: 'user', resourceId: user.id, organizationId: membership.organizationId, actor: { type: 'USER', id: user.id }, metadata: { severity: 'HIGH' } });
      await this.dashboardIp.assertAllowed(membership.organizationId);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(passwordNeedsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
      },
    });
    await this.rateLimit.reset(RATE_LIMITS.loginByIdentifier, sha256Hex(identifier.value));

    const factors = await this.prisma.mfaFactor.findMany({ where: { userId: user.id, status: 'ACTIVE' }, select: { type: true } });
    if (factors.length > 0) {
      const { token } = await this.tokens.signMfaChallenge(user.id, membership.organizationId);
      await this.audit.record({
        action: 'auth.login.mfa_challenged',
        resourceType: 'user',
        resourceId: user.id,
        organizationId: membership.organizationId,
        actor: { type: 'USER', id: user.id },
      });
      await this.loginEvents.record({ userId: user.id, organizationId: membership.organizationId, identifierMasked: maskIdentifier(identifier), outcome: 'MFA_REQUIRED', location });
      return {
        kind: 'mfa_required',
        mfaToken: token,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
        methods: { totp: factors.some((f) => f.type === 'TOTP'), passkey: factors.some((f) => f.type === 'PASSKEY') },
      };
    }

    const profile = await this.profiles.load(user.id, membership.organizationId);
    const restricted = this.config.env.AUTH_ENFORCE_MFA && (profile?.requiresMfa ?? false);
    const session = await this.completeLogin(user.id, membership.organizationId, false, restricted);
    await this.loginEvents.record({ userId: user.id, organizationId: membership.organizationId, identifierMasked: maskIdentifier(identifier), outcome: 'SUCCESS', sessionId: session.sessionId, location });
    return { kind: 'session', session };
  }

  /** Second login step: verify the TOTP code against the challenge and create the session. */
  async completeMfaLogin(mfaToken: string, verifySecondFactor: (userId: string, challengeId: string) => Promise<boolean>, location?: z.output<typeof loginLocationSchema>): Promise<IssuedSession> {
    const ip = RequestContextStore.get()?.ipAddress ?? 'unknown';
    await this.rateLimit.enforce(RATE_LIMITS.mfaByIp, ip);
    const claims = await this.tokens.verifyMfaChallenge(mfaToken);

    const attemptsKey = `mfa-attempts:${claims.jti}`;
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, MFA_CHALLENGE_TTL_SECONDS);
    if (attempts > MAX_MFA_ATTEMPTS) throw new AppError(ErrorCode.UNAUTHORIZED, 'Too many attempts. Sign in again');

    await this.dashboardIp.assertAllowed(claims.org);
    if (!(await verifySecondFactor(claims.sub, claims.jti))) {
      await this.audit.record({
        action: 'auth.mfa.failed',
        resourceType: 'user',
        resourceId: claims.sub,
        organizationId: claims.org,
        actor: { type: 'USER', id: claims.sub },
        metadata: { attempt: attempts },
      });
      await this.loginEvents.record({ userId: claims.sub, organizationId: claims.org, identifierMasked: await this.maskedUser(claims.sub), outcome: 'MFA_FAILED', mfaUsed: true, location });
      throw new AppError(ErrorCode.MFA_INVALID_CODE);
    }
    // One challenge, one session.
    await this.redis.set(attemptsKey, String(MAX_MFA_ATTEMPTS + 1), 'EX', MFA_CHALLENGE_TTL_SECONDS);

    const user = await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { status: true } });
    if (user?.status !== 'ACTIVE') throw new AppError(ErrorCode.ACCOUNT_DISABLED);
    const session = await this.completeLogin(claims.sub, claims.org, true, false);
    await this.loginEvents.record({ userId: claims.sub, organizationId: claims.org, identifierMasked: await this.maskedUser(claims.sub), outcome: 'SUCCESS', mfaUsed: true, sessionId: session.sessionId, location });
    return session;
  }

  /**
   * First session for an account that has just proved its email address (merchant self sign-up).
   * Same rules as a password sign-in without a second factor: roles that require MFA get a session
   * restricted to enrolment.
   */
  async signInNewAccount(userId: string, organizationId: string, email: string): Promise<IssuedSession> {
    const profile = await this.profiles.load(userId, organizationId);
    const restricted = this.config.env.AUTH_ENFORCE_MFA && (profile?.requiresMfa ?? false);
    const session = await this.completeLogin(userId, organizationId, false, restricted);
    await this.loginEvents.record({ userId, organizationId, identifierMasked: maskIdentifier({ kind: 'email', value: email }), outcome: 'SUCCESS', sessionId: session.sessionId });
    return session;
  }

  private async completeLogin(userId: string, organizationId: string, mfaVerified: boolean, restricted: boolean) {
    const session = await this.sessions.create({ userId, organizationId, mfaVerified, restricted });
    const ip = RequestContextStore.get()?.ipAddress ?? null;
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), lastLoginIp: ip } });
    await this.audit.record({
      action: 'auth.login.succeeded',
      resourceType: 'session',
      resourceId: session.sessionId,
      organizationId,
      actor: { type: 'USER', id: userId },
      metadata: { mfa: mfaVerified, restricted },
    });
    return session;
  }

  /** Masked email of a user (second-factor step: the identifier typed earlier isn't in the challenge). */
  private async maskedUser(userId: string): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, mobile: true } });
    if (u?.email) return maskIdentifier({ kind: 'email', value: u.email });
    if (u?.mobile) return maskIdentifier({ kind: 'mobile', value: u.mobile });
    return 'unknown';
  }

  private async registerFailedAttempt(userId: string, identifier: LoginIdentifier, location?: z.output<typeof loginLocationSchema>): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await this.auditLoginFailure(userId, identifier, 'BAD_PASSWORD', location);
    if (failedLoginCount >= this.config.env.AUTH_MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(Date.now() + this.config.env.AUTH_LOCKOUT_SECONDS * 1000);
      await this.prisma.user.update({ where: { id: userId }, data: { lockedUntil, failedLoginCount: 0 } });
      await this.audit.record({
        action: 'auth.account.locked',
        resourceType: 'user',
        resourceId: userId,
        organizationId: null,
        actor: { type: 'SYSTEM', id: null },
        metadata: { lockedUntil: lockedUntil.toISOString(), severity: 'MEDIUM' },
      });
    }
  }

  private async auditLoginFailure(userId: string | null, identifier: LoginIdentifier, reason: 'UNKNOWN_USER' | 'LOCKED' | 'BAD_PASSWORD' | 'DISABLED' | 'NOT_ACTIVATED' | 'NO_ACTIVE_ORGANIZATION', location?: z.output<typeof loginLocationSchema>) {
    await this.loginEvents.record({ userId, organizationId: null, identifierMasked: maskIdentifier(identifier), outcome: reason, location });
    return this.audit.record({
      action: 'auth.login.failed',
      resourceType: 'user',
      resourceId: userId,
      organizationId: null,
      actor: { type: 'USER', id: userId },
      metadata: { reason, identifier: maskIdentifier(identifier) },
    });
  }
}
