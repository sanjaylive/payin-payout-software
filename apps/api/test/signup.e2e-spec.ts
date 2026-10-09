import { randomInt } from 'node:crypto';
import { generateTotpCode } from '@pay2all/auth';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiConfig } from '../src/config/api-config';
import { REDIS } from '../src/infra/tokens';
import { bearer, createTestContext, extractRefreshCookie, orgBySlug, queuedMail, randomIp, type TestContext, uniqueEmail } from './helpers';

let ctx: TestContext;
const PASSWORD = 'Sunrise-Ledger-Board-2026';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
});

const mobile = () => `9${randomInt(100_000_000, 999_999_999)}`;

function details(over: Record<string, unknown> = {}) {
  return { name: 'Asha Verma', business_name: 'Verma Organics', email: uniqueEmail('signup'), mobile: mobile(), password: PASSWORD, accept_terms: true, ...over };
}

async function start(body: Record<string, unknown>, ip = randomIp()) {
  return ctx.http().post('/v1/signup').set('X-Forwarded-For', ip).send(body);
}

async function lastCode(email: string): Promise<string> {
  const mail = (await queuedMail(ctx, email)).filter((m) => m.template === 'signup_otp').pop()!;
  return /code is (\d{6})/.exec(mail.text)![1]!;
}

function verify(signupId: string, code: string, ip = randomIp()) {
  return ctx.http().post('/v1/signup/verify').set('X-Forwarded-For', ip).send({ signup_id: signupId, code });
}

describe('Merchant self sign-up', () => {
  it('reports that sign-up is open', async () => {
    const res = await ctx.http().get('/v1/signup');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: true, referrer: null });
  });

  it('creates a DRAFT merchant with its owner after the email code, then requires two-factor', async () => {
    const body = details();
    const started = await start(body);
    expect(started.status).toBe(200);
    const id = started.body.data.signup_id as string;
    expect(started.body.data.email_masked).not.toContain(body.email);

    // Nothing sensitive in Redis: hashed password, hashed code.
    const code = await lastCode(body.email);
    const raw = (await ctx.app.get<Redis>(REDIS).get(`signup:${id}`))!;
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(code);

    const wrong = await verify(id, code === '000000' ? '111111' : '000000');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/4 attempts left/);

    const ok = await verify(id, code);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(extractRefreshCookie(ok)).toBeTruthy();
    const token = ok.body.data.access_token as string;

    // The code works once.
    expect((await verify(id, code)).status).toBe(404);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: body.email }, include: { memberships: { include: { role: true } } } });
    expect(user.status).toBe('ACTIVE');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.mobile).toBe(`+91${body.mobile}`);
    expect(user.memberships.map((m) => m.role.key)).toEqual(['MERCHANT_OWNER']);
    const merchantId = user.memberships[0]!.organizationId;
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, include: { profile: true, organization: true } });
    expect(merchant.status).toBe('DRAFT');
    expect(merchant.resellerId).toBeNull();
    expect(merchant.organization.source).toBe('self-signup');
    expect(merchant.profile).toMatchObject({ displayName: 'Verma Organics', contactName: 'Asha Verma', contactEmail: body.email });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'merchant.signed_up', resourceId: merchantId } })).toBe(1);
    expect((await queuedMail(ctx, body.email)).some((m) => m.template === 'signup_welcome')).toBe(true);

    // Restricted until two-factor; then the onboarding workspace is open.
    expect((await ctx.http().get(`/v1/merchants/${merchantId}`).set(bearer(token))).status).toBe(403);
    const me = await ctx.http().get('/v1/auth/me').set(bearer(token));
    expect(me.body.data.onboarding).toEqual({ status: 'DRAFT' });
    const setup = await ctx.http().post('/v1/auth/mfa/totp/setup').set(bearer(token));
    const enabled = await ctx.http().post('/v1/auth/mfa/totp/enable').set(bearer(token)).send({ code: await generateTotpCode(setup.body.data.secret as string) });
    const full = enabled.body.data.access_token as string;
    const app = await ctx.http().get(`/v1/merchants/${merchantId}`).set(bearer(full));
    expect(app.status).toBe(200);
    expect(app.body.data.status).toBe('DRAFT');
    expect(app.body.data.requirements.find((r: { key: string }) => r.key === 'profile.contact').satisfied).toBe(true);
  });

  it('never reveals that an email is registered', async () => {
    const first = details();
    const id1 = (await start(first)).body.data.signup_id as string;
    expect((await verify(id1, await lastCode(first.email))).status).toBe(200);

    const again = await start(details({ email: first.email }));
    expect(again.status).toBe(200);
    expect(Object.keys(again.body.data).sort()).toEqual(['email_masked', 'expires_in', 'resend_after', 'signup_id']);
    const mails = await queuedMail(ctx, first.email);
    expect(mails.at(-1)!.template).toBe('signup_existing_account');
    expect(mails.filter((m) => m.template === 'signup_otp')).toHaveLength(1);
    // No code exists, so every guess fails the same way a wrong code does.
    const guess = await verify(again.body.data.signup_id as string, '123456');
    expect(guess.status).toBe(400);
    expect(guess.body.error.message).toMatch(/Incorrect or expired code/);
  });

  it('refuses a mobile number that is already registered, after the email is proven', async () => {
    const first = details();
    const id1 = (await start(first)).body.data.signup_id as string;
    expect((await verify(id1, await lastCode(first.email))).status).toBe(200);
    const second = details({ mobile: first.mobile });
    const id2 = (await start(second)).body.data.signup_id as string;
    const res = await verify(id2, await lastCode(second.email));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/mobile number is already registered/);
    expect(await ctx.prisma.user.findUnique({ where: { email: second.email } })).toBeNull();
  });

  it('attaches the merchant to the referring reseller', async () => {
    const reseller = await orgBySlug(ctx, 'acme-partners');
    const info = await ctx.http().get('/v1/signup?ref=acme-partners');
    expect(info.body.data.referrer).toEqual({ name: reseller.name });
    expect((await ctx.http().get('/v1/signup?ref=nobody-here')).body.data.referrer).toBeNull();

    const unknown = await start(details({ referral_code: 'nobody-here' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0].path).toBe('referral_code');

    const body = details({ referral_code: 'ACME-Partners' });
    const id = (await start(body)).body.data.signup_id as string;
    expect((await verify(id, await lastCode(body.email))).status).toBe(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: body.email }, include: { memberships: true } });
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: user.memberships[0]!.organizationId }, include: { organization: true } });
    expect(merchant.resellerId).toBe(reseller.id);
    expect(merchant.organization.parentId).toBe(reseller.id);
  });

  it('applies the password policy and validates input', async () => {
    const body = details();
    const weak = await start({ ...body, password: `${(body.email).split('@')[0]}-2026-pass` });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect((await start({ ...body, accept_terms: false })).status).toBe(400);
    expect((await start({ ...body, mobile: '12345' })).status).toBe(400);
    expect((await start({ ...body, company_id: 'org_x' })).status).toBe(400);
  });

  it('locks a sign-up after five wrong codes, and a new code unlocks it', async () => {
    const body = details();
    const id = (await start(body)).body.data.signup_id as string;
    const code = await lastCode(body.email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await verify(id, wrong)).status).toBe(400);
    expect((await verify(id, code)).status).toBe(429);

    // Resend has a cooldown.
    const early = await ctx.http().post('/v1/signup/resend').set('X-Forwarded-For', randomIp()).send({ signup_id: id });
    expect(early.status).toBe(429);
    const redis = ctx.app.get<Redis>(REDIS);
    const pending = JSON.parse((await redis.get(`signup:${id}`))!) as { lastSentAt: number };
    await redis.set(`signup:${id}`, JSON.stringify({ ...pending, lastSentAt: Date.now() - 60_000 }), 'KEEPTTL');
    const resent = await ctx.http().post('/v1/signup/resend').set('X-Forwarded-For', randomIp()).send({ signup_id: id });
    expect(resent.status).toBe(200);
    const fresh = await lastCode(body.email);
    expect((await verify(id, fresh)).status).toBe(200);
  });

  it('can be turned off', async () => {
    const env = ctx.app.get(ApiConfig).env as { SIGNUP_ENABLED: boolean };
    env.SIGNUP_ENABLED = false;
    try {
      expect((await ctx.http().get('/v1/signup')).body.data).toEqual({ enabled: false, referrer: null });
      const res = await start(details());
      expect(res.status).toBe(403);
    } finally {
      env.SIGNUP_ENABLED = true;
    }
  });
});
