import { randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { checkPasswordPolicy, generateToken, hashPassword, newId, sha256Hex } from '@pay2all/auth';
import { isUniqueViolation, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { signupStartSchema } from '@pay2all/validation';
import type Redis from 'ioredis';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import { maskEmail } from '../auth/auth.util';
import { AuthService } from '../auth/auth.service';
import type { IssuedSession } from '../auth/session.service';
import { MerchantsService } from '../merchants/merchants.service';

/** How long a started sign-up (and its code) stays valid. */
export const SIGNUP_TTL_SECONDS = 15 * 60;
export const OTP_TTL_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;

export const SIGNUP_LIMITS = {
  startByIp: { name: 'signup:ip', limit: 10, windowSeconds: 3600 },
  startByEmail: { name: 'signup:email', limit: 5, windowSeconds: 3600 },
  verifyByIp: { name: 'signup-verify:ip', limit: 30, windowSeconds: 300 },
} as const;

/** A started sign-up, kept only in Redis. The password is already hashed (argon2id); the code is a hash. */
interface PendingSignup {
  name: string;
  businessName: string;
  email: string;
  mobile: string;
  passwordHash: string;
  referrer: Referrer | null;
  /** The email already has an account: no code is ever sent, so verification can never succeed. */
  existing: boolean;
  codeHash: string;
  codeExpiresAt: number;
  sends: number;
  lastSentAt: number;
}

interface Referrer {
  organizationId: string;
  type: 'RESELLER' | 'API_PARTNER';
  name: string;
}

export interface SignupStarted {
  signup_id: string;
  email_masked: string;
  expires_in: number;
  resend_after: number;
}

const key = (id: string) => `signup:${id}`;
const attemptsKey = (id: string) => `signup:${id}:attempts`;
const codeHash = (id: string, code: string) => sha256Hex(`${id}:${code}`);

/**
 * Merchant self sign-up (docs/ONBOARDING.md §1): details → email code → a DRAFT merchant with its
 * owner, signed in. Never reveals whether an email is registered: an existing address gets an
 * "you already have an account" email instead of a code, and the API answers identically.
 */
@Injectable()
export class SignupService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly rateLimit: RateLimitService,
    private readonly notifications: NotificationsService,
    private readonly brand: BrandService,
    private readonly merchants: MerchantsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  private assertEnabled() {
    if (!this.config.env.SIGNUP_ENABLED) throw new AppError(ErrorCode.FORBIDDEN, 'Sign-up is not open. Contact us to get an account.');
  }

  /** Public: is sign-up open, and who referred this visitor (referral code, else a partner's custom domain)? */
  async info(ref: string | undefined, origin: string | undefined) {
    const referrer = this.config.env.SIGNUP_ENABLED ? await this.resolveReferrer(ref, origin, false) : null;
    return { enabled: this.config.env.SIGNUP_ENABLED, referrer: referrer ? { name: referrer.name } : null };
  }

  async start(input: z.output<typeof signupStartSchema>, origin: string | undefined): Promise<SignupStarted> {
    this.assertEnabled();
    const ip = RequestContextStore.get()?.ipAddress ?? 'unknown';
    await this.rateLimit.enforce(SIGNUP_LIMITS.startByIp, ip);
    await this.rateLimit.enforce(SIGNUP_LIMITS.startByEmail, sha256Hex(input.email));

    const issues = checkPasswordPolicy(input.password, { email: input.email, mobile: input.mobile });
    if (issues.length) {
      throw new AppError(ErrorCode.PASSWORD_POLICY_VIOLATION, 'Password does not meet the policy', issues.map((message) => ({ path: 'password', message })));
    }
    const referrer = await this.resolveReferrer(input.referral_code, origin, true);
    const existing = Boolean(await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }));

    const id = `su_${generateToken(24)}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const pending: PendingSignup = {
      name: input.name,
      businessName: input.business_name,
      email: input.email,
      mobile: input.mobile,
      passwordHash: await hashPassword(input.password),
      referrer,
      existing,
      codeHash: codeHash(id, code),
      codeExpiresAt: now + OTP_TTL_SECONDS * 1000,
      sends: 1,
      lastSentAt: now,
    };
    await this.redis.set(key(id), JSON.stringify(pending), 'EX', SIGNUP_TTL_SECONDS);
    await this.send(pending, code);
    return { signup_id: id, email_masked: maskEmail(input.email), expires_in: OTP_TTL_SECONDS, resend_after: RESEND_COOLDOWN_SECONDS };
  }

  async resend(id: string): Promise<SignupStarted> {
    this.assertEnabled();
    await this.rateLimit.enforce(SIGNUP_LIMITS.verifyByIp, RequestContextStore.get()?.ipAddress ?? 'unknown');
    const pending = await this.load(id);
    const wait = Math.ceil((pending.lastSentAt + RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
    if (wait > 0) throw new AppError(ErrorCode.RATE_LIMITED, `Wait ${wait}s before asking for another code`);
    if (pending.sends >= MAX_SENDS) throw new AppError(ErrorCode.RATE_LIMITED, 'Too many codes sent. Start again in a few minutes');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const next: PendingSignup = { ...pending, codeHash: codeHash(id, code), codeExpiresAt: now + OTP_TTL_SECONDS * 1000, sends: pending.sends + 1, lastSentAt: now };
    await this.redis.set(key(id), JSON.stringify(next), 'KEEPTTL');
    // A new code also gives a fresh set of attempts.
    await this.redis.del(attemptsKey(id));
    await this.send(next, code);
    return { signup_id: id, email_masked: maskEmail(pending.email), expires_in: OTP_TTL_SECONDS, resend_after: RESEND_COOLDOWN_SECONDS };
  }

  /** Check the code, then create the merchant, its owner and the first session in one go. */
  async verify(id: string, code: string): Promise<IssuedSession> {
    this.assertEnabled();
    await this.rateLimit.enforce(SIGNUP_LIMITS.verifyByIp, RequestContextStore.get()?.ipAddress ?? 'unknown');
    const pending = await this.load(id);

    const attempts = await this.redis.incr(attemptsKey(id));
    if (attempts === 1) await this.redis.expire(attemptsKey(id), SIGNUP_TTL_SECONDS);
    if (attempts > MAX_ATTEMPTS) throw new AppError(ErrorCode.RATE_LIMITED, 'Too many incorrect codes. Ask for a new code');

    const expected = Buffer.from(pending.codeHash, 'hex');
    const given = Buffer.from(codeHash(id, code), 'hex');
    const matches = !pending.existing && Date.now() < pending.codeExpiresAt && timingSafeEqual(expected, given);
    if (!matches) {
      const left = MAX_ATTEMPTS - attempts;
      throw new AppError(ErrorCode.INVALID_REQUEST, left > 0 ? `Incorrect or expired code. ${left} attempt${left === 1 ? '' : 's'} left` : 'Too many incorrect codes. Ask for a new code', [
        { path: 'code', message: 'Incorrect or expired code' },
      ]);
    }
    // One code, one account: only the caller that removes the pending sign-up goes on.
    if ((await this.redis.del(key(id))) !== 1) throw new AppError(ErrorCode.NOT_FOUND, 'Sign-up expired. Start again');
    await this.redis.del(attemptsKey(id));

    const { userId, merchantId } = await this.createAccount(pending);
    const session = await this.auth.signInNewAccount(userId, merchantId, pending.email);
    await this.notifications.queue(this.prisma, {
      template: 'signup_welcome',
      to: pending.email,
      userId,
      subject: 'Welcome to {{product}}',
      text: [
        `Hi ${pending.name},`,
        '',
        `Your {{product}} account for ${pending.businessName} is ready.`,
        'Next: secure your sign-in with two-factor, then complete onboarding (business details, directors, bank account and KYC documents) and submit it for review.',
        '',
        `Continue here: ${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}/onboarding`,
      ].join('\n'),
    });
    return session;
  }

  private async load(id: string): Promise<PendingSignup> {
    const raw = await this.redis.get(key(id));
    if (!raw) throw new AppError(ErrorCode.NOT_FOUND, 'Sign-up expired. Start again');
    return JSON.parse(raw) as PendingSignup;
  }

  private async send(p: PendingSignup, code: string) {
    if (p.existing) {
      await this.notifications.queue(this.prisma, {
        template: 'signup_existing_account',
        to: p.email,
        subject: 'You already have a {{short}} account',
        text: [
          'Someone (hopefully you) tried to sign up with this email address, but it already has an account.',
          '',
          `Sign in: ${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
          `Forgot your password? ${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}/forgot-password`,
          '',
          "If this wasn't you, you can ignore this email.",
        ].join('\n'),
      });
      return;
    }
    await this.notifications.queue(this.prisma, {
      template: 'signup_otp',
      to: p.email,
      subject: 'Verify your email for {{short}}',
      text: [
        `Hi ${p.name},`,
        '',
        `Your {{product}} verification code is ${code}`,
        '',
        `It expires in ${OTP_TTL_SECONDS / 60} minutes. Never share this code with anyone; we will never ask for it.`,
        "If you didn't start a sign-up, you can ignore this email.",
      ].join('\n'),
    });
  }

  /**
   * Referral code (an active reseller's or API partner's slug) wins; otherwise a partner's verified
   * custom domain the browser is on (Origin header, set by the browser). Unknown codes are an error
   * only when signing up, so a stale link still shows the form.
   */
  private async resolveReferrer(code: string | undefined, origin: string | undefined, strict: boolean): Promise<Referrer | null> {
    if (code) {
      const org = await this.prisma.organization.findUnique({ where: { slug: code }, select: { id: true, type: true, status: true, name: true } });
      if (org && org.status === 'ACTIVE' && (org.type === 'RESELLER' || org.type === 'API_PARTNER')) return { organizationId: org.id, type: org.type, name: org.name };
      if (strict) throw new AppError(ErrorCode.INVALID_REQUEST, 'Referral code not recognised', [{ path: 'referral_code', message: 'Referral code not recognised' }]);
      return null;
    }
    let host: string | undefined;
    try {
      host = origin ? new URL(origin).host : undefined;
    } catch {
      host = undefined;
    }
    if (!host) return null;
    const owner = (await this.brand.forHost(host.slice(0, 253))).owner?.organization_id;
    if (!owner) return null;
    const org = await this.prisma.organization.findUnique({ where: { id: owner }, select: { id: true, type: true, status: true, name: true } });
    return org && org.status === 'ACTIVE' && (org.type === 'RESELLER' || org.type === 'API_PARTNER') ? { organizationId: org.id, type: org.type, name: org.name } : null;
  }

  private async createAccount(p: PendingSignup): Promise<{ userId: string; merchantId: string }> {
    const ownerRole = await this.prisma.role.findFirstOrThrow({ where: { key: 'MERCHANT_OWNER', organizationId: null }, select: { id: true } });
    const userId = newId('user');
    try {
      const merchantId = await this.prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { id: userId, name: p.name, email: p.email, mobile: p.mobile, passwordHash: p.passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() } });
        const r = p.referrer;
        const merchantId = await this.merchants.createInTx(tx, { userId }, {
          displayName: p.businessName,
          resellerId: r?.type === 'RESELLER' ? r.organizationId : null,
          parentId: r?.organizationId ?? null,
          source: r ? 'self-signup:referral' : 'self-signup',
          contact: { name: p.name, email: p.email, mobile: p.mobile },
        });
        await tx.userRole.create({ data: { id: newId('membership'), userId, roleId: ownerRole.id, organizationId: merchantId } });
        await this.audit.record(
          {
            action: 'merchant.signed_up',
            resourceType: 'merchant',
            resourceId: merchantId,
            organizationId: merchantId,
            actor: { type: 'USER', id: userId, role: 'MERCHANT_OWNER' },
            newValue: { business_name: p.businessName, owner_email: maskEmail(p.email), referrer_id: r?.organizationId ?? null },
          },
          tx,
        );
        return merchantId;
      });
      return { userId, merchantId };
    } catch (err) {
      if (isUniqueViolation(err, 'mobile')) throw new AppError(ErrorCode.CONFLICT, 'This mobile number is already registered. Sign in, or sign up with another number');
      if (isUniqueViolation(err, 'email')) throw new AppError(ErrorCode.CONFLICT, 'This email is already registered. Sign in instead');
      throw err;
    }
  }
}
