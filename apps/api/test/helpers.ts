import { randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { generateTotpCode, hashPassword, newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/app.factory';
import { ApiConfig } from '../src/config/api-config';
import { FieldEncryptor } from '@pay2all/auth';
import { notificationAad } from '../src/infra/notifications.service';
import { PRISMA } from '../src/infra/tokens';

export const SEED_PASSWORD = 'Test-Seed-Password-2026!';
export const ORIGIN = 'http://localhost:3000';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  http: () => TestAgent;
}

export async function createTestContext(): Promise<TestContext> {
  const app = await createApp(ApiConfig.fromProcessEnv());
  await app.init();
  return {
    app,
    prisma: app.get<PrismaClient>(PRISMA),
    http: () => request(app.getHttpServer()),
  };
}

/** A random client IP per call so per-IP rate limits don't leak between tests. */
export function randomIp(): string {
  return `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${Date.now()}.${randomInt(0, 1_000_000)}@test.local`;
}

export function extractRefreshCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  const cookie = cookies.find((c) => c.startsWith('p2a_rt='));
  if (!cookie) return null;
  const value = cookie.split(';')[0]!.slice('p2a_rt='.length);
  return value.length ? value : null;
}

export async function login(ctx: TestContext, identifier: string, password = SEED_PASSWORD, ip = randomIp()) {
  const res = await ctx.http().post('/v1/auth/login').set('X-Forwarded-For', ip).send({ identifier, password });
  return { res, accessToken: res.body?.data?.access_token as string | undefined, refresh: extractRefreshCookie(res) };
}

export function refresh(ctx: TestContext, refreshToken: string, ip = randomIp()) {
  return ctx
    .http()
    .post('/v1/auth/refresh')
    .set('X-Forwarded-For', ip)
    .set('X-Pay2All-CSRF', '1')
    .set('Origin', ORIGIN)
    .set('Cookie', `p2a_rt=${refreshToken}`);
}

export async function orgBySlug(ctx: TestContext, slug: string) {
  return ctx.prisma.organization.findUniqueOrThrow({ where: { slug } });
}

/** Create an ACTIVE user with a role in an org directly in the DB (fast fixture). */
export async function createUser(
  ctx: TestContext,
  opts: { roleKey: string; organizationId: string; email?: string; password?: string; mobile?: string },
) {
  const role = await ctx.prisma.role.findFirstOrThrow({ where: { key: opts.roleKey, organizationId: null } });
  const user = await ctx.prisma.user.create({
    data: {
      id: newId('user'),
      name: `Test ${opts.roleKey}`,
      email: opts.email ?? uniqueEmail(opts.roleKey.toLowerCase()),
      mobile: opts.mobile ?? null,
      passwordHash: await hashPassword(opts.password ?? SEED_PASSWORD),
      status: 'ACTIVE',
    },
  });
  await ctx.prisma.userRole.create({
    data: { id: newId('membership'), userId: user.id, roleId: role.id, organizationId: opts.organizationId },
  });
  return user;
}

/**
 * Full privileged login: password → restricted session → TOTP enrollment → full session.
 * Returns the access token and the TOTP secret for later MFA logins.
 */
export async function loginWithMfaEnrollment(ctx: TestContext, email: string) {
  const first = await login(ctx, email);
  const restrictedToken = first.accessToken!;
  const setup = await ctx.http().post('/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${restrictedToken}`);
  const secret = setup.body.data.secret as string;
  const code = await generateTotpCode(secret);
  const enable = await ctx
    .http()
    .post('/v1/auth/mfa/totp/enable')
    .set('Authorization', `Bearer ${restrictedToken}`)
    .send({ code });
  return { accessToken: enable.body.data.access_token as string, secret, refresh: first.refresh };
}

/**
 * Sign in to a full session whatever the user's two-factor state: enrolls TOTP when the role requires
 * it, or answers the TOTP challenge using the stored secret (tests only — decrypted with the app key).
 */
export async function signIn(ctx: TestContext, identifier: string, password = SEED_PASSWORD, ip = randomIp()) {
  const first = await login(ctx, identifier, password, ip);
  const status = first.res.body?.data?.status as string | undefined;
  if (status === 'MFA_ENROLLMENT_REQUIRED') {
    const setup = await ctx.http().post('/v1/auth/mfa/totp/setup').set('X-Forwarded-For', ip).set('Authorization', `Bearer ${first.accessToken!}`);
    const enable = await ctx.http().post('/v1/auth/mfa/totp/enable').set('X-Forwarded-For', ip).set('Authorization', `Bearer ${first.accessToken!}`).send({ code: await generateTotpCode(setup.body.data.secret) });
    return { res: enable, accessToken: enable.body.data.access_token as string, refresh: first.refresh };
  }
  if (status !== 'MFA_REQUIRED') return first;
  const enc = ctx.app.get(FieldEncryptor);
  const claims = JSON.parse(Buffer.from((first.res.body.data.mfa_token as string).split('.')[1]!, 'base64url').toString()) as { sub: string };
  const factor = await ctx.prisma.mfaFactor.findFirstOrThrow({ where: { userId: claims.sub, type: 'TOTP', status: 'ACTIVE' } });
  // Several sign-ins of one seeded user can fall in the same 30 s step; reset the replay watermark.
  await ctx.prisma.mfaFactor.update({ where: { id: factor.id }, data: { lastUsedStep: null } });
  const code = await generateTotpCode(enc.decrypt(factor.secretEncrypted!, claims.sub));
  const verify = await ctx.http().post('/v1/auth/mfa/verify').set('X-Forwarded-For', ip).send({ mfa_token: first.res.body.data.mfa_token, code });
  return { res: verify, accessToken: verify.body.data?.access_token as string | undefined, refresh: extractRefreshCookie(verify) };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export interface QueuedMail {
  id: string;
  to: string;
  subject: string;
  text: string;
  template: string;
}

/** Emails queued for the notification worker, decrypted (tests only — content is encrypted at rest). */
export async function queuedMail(ctx: TestContext, to?: string): Promise<QueuedMail[]> {
  const enc = ctx.app.get(FieldEncryptor);
  const rows = await ctx.prisma.notification.findMany({ where: { contentEncrypted: { not: null } }, orderBy: { createdAt: 'asc' } });
  return rows
    .map((r) => ({ id: r.id, template: r.template, ...(JSON.parse(enc.decrypt(r.contentEncrypted!, notificationAad(r.id))) as { to: string; subject: string; text: string }) }))
    .filter((m) => !to || m.to === to);
}

/** A fresh APPROVED merchant (direct, no reseller) with an owner session — isolates money tests. */
export async function createApprovedMerchant(ctx: TestContext, opts: { payoutEnabled?: boolean } = {}) {
  const platform = await orgBySlug(ctx, 'pay2all');
  const id = newId('organization');
  await ctx.prisma.organization.create({ data: { id, slug: `m-${id.slice(-10).toLowerCase()}`, name: `Merchant ${id.slice(-6)}`, type: 'MERCHANT', parentId: platform.id } });
  await ctx.prisma.merchant.create({ data: { id, status: 'APPROVED', payinEnabled: true, payoutEnabled: opts.payoutEnabled ?? true, approvedAt: new Date() } });
  await ctx.prisma.merchantProfile.create({ data: { merchantId: id, displayName: 'Test merchant' } });
  await ctx.prisma.merchantKyc.create({ data: { merchantId: id } });
  // Owners must use two-factor (docs/SECURITY.md §1.5): sign in through enrollment.
  const enrolled = await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: id })).email);
  return { id, owner: enrolled.accessToken, ownerTotpSecret: enrolled.secret };
}
