import { generateTotpCode, sha256Hex } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestContext,
  createUser,
  extractRefreshCookie,
  login,
  loginWithMfaEnrollment,
  ORIGIN,
  orgBySlug,
  randomIp,
  refresh,
  SEED_PASSWORD,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let merchantOrgId: string;
let platformOrgId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  merchantOrgId = (await orgBySlug(ctx, 'sharma-electronics')).id;
  platformOrgId = (await orgBySlug(ctx, 'pay2all')).id;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('login', () => {
  it('authenticates with email and sets a hardened refresh cookie', async () => {
    const { res, accessToken } = await login(ctx, 'owner@sharma-electronics.local');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'AUTHENTICATED', token_type: 'Bearer' } });
    expect(accessToken).toBeTruthy();
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('p2a_rt='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    // The refresh token must never appear in the JSON body.
    expect(JSON.stringify(res.body)).not.toContain(extractRefreshCookie(res)!);
  });

  it('authenticates with a mobile number in any common format', async () => {
    const { res } = await login(ctx, '98765 00001');
    expect(res.status).toBe(200);
  });

  it('returns the same error for unknown users and wrong passwords', async () => {
    const unknown = await login(ctx, 'nobody@nowhere.local', 'whatever-password');
    const wrong = await login(ctx, 'owner@kirana-fresh.local', 'definitely-wrong-password');
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.res.body.error.message).toBe(wrong.res.body.error.message);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const user = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: merchantOrgId });
    for (let i = 0; i < 5; i++) await login(ctx, user.email, 'wrong-password-attempt');
    const locked = await login(ctx, user.email);
    expect(locked.res.status).toBe(423);
    expect(locked.res.body.error.code).toBe('ACCOUNT_LOCKED');
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'auth.account.locked', resourceId: user.id } });
    expect(audit).not.toBeNull();
  });

  it('rate-limits login attempts per client IP', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await login(ctx, `ghost${i}@nowhere.local`, 'x', ip)).res.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('rejects unknown body fields (no smuggled tenant ids)', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', randomIp())
      .send({ identifier: 'owner@sharma-electronics.local', password: SEED_PASSWORD, organization_id: platformOrgId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('records login success and failure in the audit log with the request id', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', randomIp())
      .set('X-Request-Id', 'req_test_correlation_1234')
      .send({ identifier: 'owner@sharma-electronics.local', password: SEED_PASSWORD });
    expect(res.headers['x-request-id']).toBe('req_test_correlation_1234');
    const row = await ctx.prisma.auditLog.findFirst({
      where: { action: 'auth.login.succeeded', requestId: 'req_test_correlation_1234' },
    });
    expect(row).not.toBeNull();
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const { refresh: rt1 } = await login(ctx, 'owner@sharma-electronics.local');
    const res = await refresh(ctx, rt1!);
    expect(res.status).toBe(200);
    const rt2 = extractRefreshCookie(res);
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);
    expect((await refresh(ctx, rt2!)).status).toBe(200);
  });

  it('detects reuse of a consumed refresh token and revokes the whole session', async () => {
    const { refresh: rt1, accessToken } = await login(ctx, 'owner@sharma-electronics.local');
    const rotated = await refresh(ctx, rt1!);
    const rt2 = extractRefreshCookie(rotated)!;
    // Move the consumption time outside the concurrency grace window.
    await ctx.prisma.refreshToken.update({
      where: { tokenHash: sha256Hex(rt1!) },
      data: { usedAt: new Date(Date.now() - 60_000) },
    });

    const replay = await refresh(ctx, rt1!);
    expect(replay.status).toBe(401);

    // The legitimate (newer) token and the access token are now dead too.
    expect((await refresh(ctx, rt2)).status).toBe(401);
    const me = await ctx.http().get('/v1/auth/me').set(bearer(accessToken!));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_EXPIRED');
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'auth.refresh_token.reuse_detected' }, orderBy: { createdAt: 'desc' } });
    expect(audit).not.toBeNull();
  });

  it('lets exactly one of several concurrent refreshes with the same token succeed', async () => {
    const { refresh: rt } = await login(ctx, 'owner@sharma-electronics.local');
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(ctx, rt!)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('requires the CSRF header and an allowed origin', async () => {
    const { refresh: rt } = await login(ctx, 'owner@sharma-electronics.local');
    const noHeader = await ctx.http().post('/v1/auth/refresh').set('Cookie', `p2a_rt=${rt}`);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_REJECTED');
    const badOrigin = await ctx
      .http()
      .post('/v1/auth/refresh')
      .set('Cookie', `p2a_rt=${rt}`)
      .set('X-Pay2All-CSRF', '1')
      .set('Origin', 'https://evil.example');
    expect(badOrigin.status).toBe(403);
  });
});

describe('sessions and logout', () => {
  it('logout revokes the session immediately (access token rejected)', async () => {
    const { accessToken, refresh: rt } = await login(ctx, 'owner@kirana-fresh.local');
    const out = await ctx
      .http()
      .post('/v1/auth/logout')
      .set('X-Pay2All-CSRF', '1')
      .set('Origin', ORIGIN)
      .set('Cookie', `p2a_rt=${rt}`);
    expect(out.status).toBe(200);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(accessToken!))).status).toBe(401);
    expect((await refresh(ctx, rt!)).status).toBe(401);
  });

  it('lists own sessions and revokes a specific one; logout-all revokes the rest', async () => {
    const user = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: merchantOrgId });
    const a = await login(ctx, user.email);
    const b = await login(ctx, user.email);
    const c = await login(ctx, user.email);

    const list = await ctx.http().get('/v1/auth/sessions').set(bearer(a.accessToken!));
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const bSessionId = (await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(b.refresh!) } })).sessionId;
    expect((await ctx.http().delete(`/v1/auth/sessions/${bSessionId}`).set(bearer(a.accessToken!))).status).toBe(200);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(b.accessToken!))).status).toBe(401);

    const all = await ctx.http().post('/v1/auth/logout-all').set(bearer(a.accessToken!));
    expect(all.body.data.revoked_sessions).toBe(2);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(c.accessToken!))).status).toBe(401);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(a.accessToken!))).status).toBe(401);
  });

  it("cannot revoke another user's session", async () => {
    const owner = await login(ctx, 'owner@sharma-electronics.local');
    const other = await login(ctx, 'owner@kirana-fresh.local');
    const otherSessionId = (await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(other.refresh!) } })).sessionId;
    const res = await ctx.http().delete(`/v1/auth/sessions/${otherSessionId}`).set(bearer(owner.accessToken!));
    expect(res.status).toBe(404);
  });
});

describe('password reset', () => {
  it('sends a single-use link, resets the password and revokes existing sessions', async () => {
    const user = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: merchantOrgId });
    const before = await login(ctx, user.email);

    const forgot = await ctx.http().post('/v1/auth/password/forgot').set('X-Forwarded-For', randomIp()).send({ identifier: user.email });
    expect(forgot.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // background send
    const mail = ctx.mail.memoryOutbox.findLast((m) => m.to === user.email)!;
    const token = /token=([^\s&]+)/.exec(mail.text)![1]!;

    const weak = await ctx.http().post('/v1/auth/password/reset').send({ token: decodeURIComponent(token), new_password: 'short' });
    expect(weak.status).toBe(400);

    const ok = await ctx.http().post('/v1/auth/password/reset').send({ token: decodeURIComponent(token), new_password: 'A-brand-new-passphrase-42' });
    expect(ok.status).toBe(200);
    const reuse = await ctx.http().post('/v1/auth/password/reset').send({ token: decodeURIComponent(token), new_password: 'Another-passphrase-4242' });
    expect(reuse.body.error.code).toBe('INVALID_RESET_TOKEN');

    expect((await ctx.http().get('/v1/auth/me').set(bearer(before.accessToken!))).status).toBe(401);
    expect((await login(ctx, user.email)).res.status).toBe(401);
    expect((await login(ctx, user.email, 'A-brand-new-passphrase-42')).res.status).toBe(200);
  });

  it('responds identically for unknown identifiers and sends nothing', async () => {
    const count = ctx.mail.memoryOutbox.length;
    const res = await ctx.http().post('/v1/auth/password/forgot').set('X-Forwarded-For', randomIp()).send({ identifier: 'nobody@nowhere.local' });
    expect(res.status).toBe(200);
    expect(ctx.mail.memoryOutbox.length).toBe(count);
  });
});

describe('MFA', () => {
  it('forces privileged users to enroll before reaching protected routes, then requires TOTP at login', async () => {
    const admin = await createUser(ctx, { roleKey: 'ADMIN', organizationId: platformOrgId });

    const first = await login(ctx, admin.email);
    expect(first.res.body.data.status).toBe('MFA_ENROLLMENT_REQUIRED');
    const blocked = await ctx.http().get('/v1/users').set(bearer(first.accessToken!));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await ctx.http().get('/v1/auth/me').set(bearer(first.accessToken!))).status).toBe(200);

    const enrolled = await loginWithMfaEnrollment(ctx, admin.email);
    expect((await ctx.http().get('/v1/users').set(bearer(enrolled.accessToken))).status).toBe(200);

    // MFA secret is stored encrypted, never in plaintext.
    const factor = await ctx.prisma.mfaFactor.findFirstOrThrow({ where: { userId: admin.id, status: 'ACTIVE' } });
    expect(factor.secretEncrypted).not.toContain(enrolled.secret);

    const second = await login(ctx, admin.email);
    expect(second.res.body.data.status).toBe('MFA_REQUIRED');
    expect(second.refresh).toBeNull(); // no session before the second factor
    const mfaToken = second.res.body.data.mfa_token as string;

    const wrong = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: mfaToken, code: '000000' });
    expect(wrong.body.error.code).toBe('MFA_INVALID_CODE');

    // Code from the next step (enrollment consumed the current one — replay protection).
    const code = await generateTotpCode(enrolled.secret, Math.floor(Date.now() / 1000) + 30);
    const ok = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: mfaToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('AUTHENTICATED');

    // Same code cannot be replayed on a fresh challenge.
    const third = await login(ctx, admin.email);
    const replay = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: third.res.body.data.mfa_token, code });
    expect(replay.body.error.code).toBe('MFA_INVALID_CODE');
  });

  it('refuses an access token presented as an MFA challenge token', async () => {
    const { accessToken } = await login(ctx, 'owner@sharma-electronics.local');
    const res = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: accessToken, code: '123456' });
    expect(res.status).toBe(401);
  });

  it('does not let mandatory-MFA roles disable their factor', async () => {
    const admin = await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platformOrgId });
    const enrolled = await loginWithMfaEnrollment(ctx, admin.email);
    const code = await generateTotpCode(enrolled.secret, Math.floor(Date.now() / 1000) + 30);
    const res = await ctx
      .http()
      .post('/v1/auth/mfa/totp/disable')
      .set(bearer(enrolled.accessToken))
      .send({ code, password: SEED_PASSWORD });
    expect(res.status).toBe(403);
  });
});
