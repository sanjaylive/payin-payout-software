import { Inject, Injectable } from '@nestjs/common';
import { verifyPassword } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';
import { MfaService } from './mfa.service';
import { PasskeyService } from './passkey.service';

const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 300;

export type StepUpProof = { code?: string; recovery_code?: string; passkey?: Record<string, unknown>; password?: string };

/**
 * Step-up authentication (docs/SECURITY.md §1.9): sensitive actions need proof of identity from the
 * last few minutes, not just a valid session — a stolen or unattended session can't add API keys,
 * move money or change credentials. Users with two-factor confirm with it; users without two-factor
 * (roles where it's optional) re-enter their password.
 */
@Injectable()
export class StepUpService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly mfa: MfaService,
    private readonly passkeys: PasskeyService,
    private readonly audit: AuditService,
  ) {}

  private get windowMs() {
    return this.config.env.AUTH_STEP_UP_SECONDS * 1000;
  }

  async isFresh(actor: Actor): Promise<boolean> {
    if (actor.kind !== 'user') return true;
    const session = await this.prisma.session.findUnique({ where: { id: actor.sessionId }, select: { reauthenticatedAt: true } });
    return Boolean(session && Date.now() - session.reauthenticatedAt.getTime() <= this.windowMs);
  }

  async assertFresh(actor: Actor): Promise<void> {
    if (!(await this.isFresh(actor))) throw new AppError(ErrorCode.STEP_UP_REQUIRED);
  }

  async methods(actor: Actor) {
    const [factors, codes] = await Promise.all([
      this.prisma.mfaFactor.findMany({ where: { userId: actor.userId, status: 'ACTIVE' }, select: { type: true } }),
      this.prisma.mfaRecoveryCode.count({ where: { userId: actor.userId, usedAt: null } }),
    ]);
    const totp = factors.some((f) => f.type === 'TOTP');
    const passkey = factors.some((f) => f.type === 'PASSKEY');
    return {
      totp,
      passkey,
      recovery_code: factors.length > 0 && codes > 0,
      password: factors.length === 0,
      fresh: await this.isFresh(actor),
      window_seconds: this.config.env.AUTH_STEP_UP_SECONDS,
    };
  }

  passkeyOptions(actor: Actor) {
    return this.passkeys.authenticationOptions(actor.userId, 'step-up', actor.sessionId);
  }

  async confirm(actor: Actor, proof: StepUpProof) {
    const attemptsKey = `step-up-attempts:${actor.sessionId}`;
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, ATTEMPT_WINDOW_SECONDS);
    if (attempts > MAX_ATTEMPTS) throw new AppError(ErrorCode.RATE_LIMITED, 'Too many attempts. Wait a few minutes and try again.');

    const methods = await this.methods(actor);
    let ok = false;
    let method: string;
    if (proof.passkey) {
      method = 'passkey';
      ok = methods.passkey && (await this.passkeys.verifyAssertion(actor.userId, 'step-up', actor.sessionId, proof.passkey));
    } else if (proof.code) {
      method = 'totp';
      ok = methods.totp && (await this.mfa.verifyForLogin(actor.userId, proof.code));
    } else if (proof.recovery_code) {
      method = 'recovery_code';
      ok = methods.recovery_code && (await this.mfa.verifyRecoveryCode(actor.userId, proof.recovery_code));
    } else {
      method = 'password';
      // Password alone is accepted only when the user has no second factor to offer.
      if (methods.password && proof.password) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { passwordHash: true } });
        ok = await verifyPassword(user.passwordHash, proof.password);
      }
    }
    if (!ok) {
      await this.audit.record({ action: 'auth.step_up.failed', resourceType: 'session', resourceId: actor.sessionId, metadata: { method, attempt: attempts, severity: attempts >= 3 ? 'MEDIUM' : 'LOW' } });
      throw new AppError(method === 'password' ? ErrorCode.INVALID_CREDENTIALS : ErrorCode.MFA_INVALID_CODE);
    }
    const now = new Date();
    await this.prisma.session.update({ where: { id: actor.sessionId }, data: { reauthenticatedAt: now } });
    await this.redis.del(attemptsKey);
    await this.audit.record({ action: 'auth.step_up.succeeded', resourceType: 'session', resourceId: actor.sessionId, metadata: { method } });
    return { confirmed: true, valid_until: new Date(now.getTime() + this.windowMs) };
  }
}
