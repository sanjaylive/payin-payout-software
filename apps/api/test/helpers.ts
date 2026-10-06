import { randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { generateTotpCode, hashPassword, newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/app.factory';
import { ApiConfig } from '../src/config/api-config';
import { MailService } from '../src/infra/mail.service';
import { PRISMA } from '../src/infra/tokens';

export const SEED_PASSWORD = 'Test-Seed-Password-2026!';
export const ORIGIN = 'http://localhost:3000';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  mail: MailService;
  http: () => TestAgent;
}

export async function createTestContext(): Promise<TestContext> {
  const app = await createApp(ApiConfig.fromProcessEnv());
  await app.init();
  return {
    app,
    prisma: app.get<PrismaClient>(PRISMA),
    mail: app.get(MailService),
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

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}
