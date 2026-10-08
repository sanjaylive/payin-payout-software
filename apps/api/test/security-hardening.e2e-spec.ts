import { generateTotpCode } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, createUser, extractRefreshCookie, login, loginWithMfaEnrollment, ORIGIN, SEED_PASSWORD, type TestContext } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
});

/** Make the session's last proof of identity older than the step-up window. */
async function ageSession(token: string) {
  const sid = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid as string;
  await ctx.prisma.session.update({ where: { id: sid }, data: { reauthenticatedAt: new Date(Date.now() - 2 * 3600_000) } });
}

async function addPasskey(token: string, auth: SoftAuthenticator, name = 'Laptop') {
  const options = await ctx.http().post('/v1/auth/passkeys/register/options').set(bearer(token));
  expect(options.status).toBe(200);
  expect(options.body.data.rp.id).toBe('localhost');
  return ctx.http().post('/v1/auth/passkeys/register').set(bearer(token)).send({ name, response: auth.create(options.body.data) });
}

describe('Mandatory two-factor for merchant owners and admins', () => {
  it('signs an owner without two-factor into an enrollment-only session', async () => {
    const m = await createApprovedMerchant(ctx);
    for (const roleKey of ['MERCHANT_OWNER', 'MERCHANT_ADMIN']) {
      const user = await createUser(ctx, { roleKey, organizationId: m.id });
      const first = await login(ctx, user.email);
      expect(first.res.body.data.status).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((await ctx.http().get('/v1/payments').set(bearer(first.accessToken!))).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    }
    // Optional roles are unchanged.
    const ops = await createUser(ctx, { roleKey: 'MERCHANT_OPERATIONS', organizationId: m.id });
    expect((await login(ctx, ops.email)).res.body.data.status).toBe('AUTHENTICATED');
  });
});

describe('Passkeys', () => {
  it('enrolls a passkey as the first factor (lifts the restricted session, issues recovery codes)', async () => {
    const m = await createApprovedMerchant(ctx);
    const user = await createUser(ctx, { roleKey: 'MERCHANT_ADMIN', organizationId: m.id });
    const restricted = (await login(ctx, user.email)).accessToken!;
    const auth = new SoftAuthenticator();
    const res = await addPasskey(restricted, auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('AUTHENTICATED');
    expect(res.body.data.recovery_codes).toHaveLength(10);
    const token = res.body.data.access_token as string;
    expect((await ctx.http().get('/v1/payments').set(bearer(token))).status).toBe(200);

    // Stored: public key + counter only; no secret.
    const factor = await ctx.prisma.mfaFactor.findFirstOrThrow({ where: { userId: user.id, type: 'PASSKEY' } });
    expect(factor.secretEncrypted).toBeNull();
    expect(factor.credentialId).toBe(auth.id);

    // Sign-in: password → passkey.
    const first = await login(ctx, user.email);
    expect(first.res.body.data).toMatchObject({ status: 'MFA_REQUIRED', mfa_methods: { passkey: true, totp: false } });
    const mfaToken = first.res.body.data.mfa_token as string;
    const options = await ctx.http().post('/v1/auth/mfa/passkey/options').send({ mfa_token: mfaToken });
    expect(options.body.data.allowCredentials[0].id).toBe(auth.id);
    const assertion = auth.get(options.body.data);
    const ok = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: mfaToken, passkey: assertion });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('AUTHENTICATED');

    // The same assertion can't be replayed (challenge is single use).
    const again = await login(ctx, user.email);
    const replay = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: again.res.body.data.mfa_token, passkey: assertion });
    expect(replay.body.error.code).toBe('MFA_INVALID_CODE');
  });

  it('rejects an assertion made for another website (phishing) and a cloned authenticator', async () => {
    const m = await createApprovedMerchant(ctx);
    const user = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: m.id });
    const auth = new SoftAuthenticator();
    await addPasskey((await login(ctx, user.email)).accessToken!, auth);

    const phish = await login(ctx, user.email);
    const o1 = await ctx.http().post('/v1/auth/mfa/passkey/options').send({ mfa_token: phish.res.body.data.mfa_token });
    const bad = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: phish.res.body.data.mfa_token, passkey: auth.get(o1.body.data, { origin: 'https://pay2all-login.example' }) });
    expect(bad.body.error.code).toBe('MFA_INVALID_CODE');

    const good = await login(ctx, user.email);
    const o2 = await ctx.http().post('/v1/auth/mfa/passkey/options').send({ mfa_token: good.res.body.data.mfa_token });
    expect((await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: good.res.body.data.mfa_token, passkey: auth.get(o2.body.data, { counter: 10 }) })).status).toBe(200);

    // A copy of the key presenting an older counter.
    const clone = await login(ctx, user.email);
    const o3 = await ctx.http().post('/v1/auth/mfa/passkey/options').send({ mfa_token: clone.res.body.data.mfa_token });
    const cloned = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: clone.res.body.data.mfa_token, passkey: auth.get(o3.body.data, { counter: 5 }) });
    expect(cloned.body.error.code).toBe('MFA_INVALID_CODE');
  });

  it("won't remove the last factor of a role that requires two-factor; a second passkey needs step-up", async () => {
    const m = await createApprovedMerchant(ctx);
    const user = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: m.id });
    const auth = new SoftAuthenticator();
    const token = (await addPasskey((await login(ctx, user.email)).accessToken!, auth)).body.data.access_token as string;
    const [pk] = (await ctx.http().get('/v1/auth/passkeys').set(bearer(token))).body.data as { id: string }[];
    const del = await ctx.http().delete(`/v1/auth/passkeys/${pk!.id}`).set(bearer(token));
    expect(del.status).toBe(403);
    expect(del.body.error.message).toMatch(/mandatory/);

    await ageSession(token);
    expect((await ctx.http().post('/v1/auth/passkeys/register/options').set(bearer(token))).body.error.code).toBe('STEP_UP_REQUIRED');
    const opts = await ctx.http().post('/v1/auth/step-up/passkey/options').set(bearer(token));
    expect((await ctx.http().post('/v1/auth/step-up').set(bearer(token)).send({ passkey: auth.get(opts.body.data) })).status).toBe(200);
    const second = await addPasskey(token, new SoftAuthenticator(), 'Phone');
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.recovery_codes).toBeUndefined(); // existing codes stay valid
    expect((await ctx.http().delete(`/v1/auth/passkeys/${pk!.id}`).set(bearer(token))).status).toBe(200);
  });
});

describe('Step-up for sensitive actions', () => {
  it('requires a recent confirmation to create an API key, and accepts an authenticator code', async () => {
    const m = await createApprovedMerchant(ctx);
    const owner = await ctx.prisma.userRole.findFirstOrThrow({ where: { organizationId: m.id }, include: { user: true } });
    const token = m.owner;
    // Fresh sign-in counts as a recent confirmation.
    expect((await ctx.http().post('/v1/developers/api-keys').set(bearer(token)).send({ name: 'Fresh' })).status).toBe(201);

    await ageSession(token);
    const blocked = await ctx.http().post('/v1/developers/api-keys').set(bearer(token)).send({ name: 'Stale' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('STEP_UP_REQUIRED');

    const methods = await ctx.http().get('/v1/auth/step-up').set(bearer(token));
    expect(methods.body.data).toMatchObject({ totp: true, passkey: false, password: false, fresh: false });
    // Password is not accepted from someone who has two-factor.
    expect((await ctx.http().post('/v1/auth/step-up').set(bearer(token)).send({ password: SEED_PASSWORD })).status).toBe(401);

    const secret = m.ownerTotpSecret;
    const code = await generateTotpCode(secret, Math.floor(Date.now() / 1000) + 30); // next step: enrollment used this one
    const ok = await ctx.http().post('/v1/auth/step-up').set(bearer(token)).send({ code });
    expect(ok.status).toBe(200);
    expect((await ctx.http().post('/v1/developers/api-keys').set(bearer(token)).send({ name: 'After step-up' })).status).toBe(201);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.step_up.succeeded', actorId: owner.userId } })).toBe(1);
  });

  it('lets users without two-factor confirm with their password, and limits attempts', async () => {
    const m = await createApprovedMerchant(ctx);
    const ops = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id });
    const token = (await login(ctx, ops.email)).accessToken!;
    await ageSession(token);
    const add = () => ctx.http().post('/v1/payouts').set(bearer(token)).set('Idempotency-Key', `k_${Date.now()}${Math.random().toString(16).slice(2)}`).send({ merchant_order_id: `ord_${Date.now()}`, amount: '60000.00', mode: 'IMPS', beneficiary: { name: 'Asha Rao', account_number: '1234567890', ifsc: 'HDFC0000001' } });
    const big = await add();
    expect(big.body.error.code).toBe('STEP_UP_REQUIRED');
    for (let i = 0; i < 5; i++) expect((await ctx.http().post('/v1/auth/step-up').set(bearer(token)).send({ password: 'wrong-password-123' })).status).toBe(401);
    expect((await ctx.http().post('/v1/auth/step-up').set(bearer(token)).send({ password: SEED_PASSWORD })).body.error.code).toBe('RATE_LIMITED');
  });
});

describe('Dashboard IP allowlist', () => {
  it('refuses changes that would lock out the caller, then enforces at login, per request and at refresh', async () => {
    const m = await createApprovedMerchant(ctx);
    const office = '198.51.100.20';
    const home = '203.0.113.99';
    const user = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: m.id });
    const enrolled = await loginWithMfaEnrollment(ctx, user.email);
    const token = enrolled.accessToken;
    const at = (ip: string) => ({ ...bearer(token), 'X-Forwarded-For': ip });

    const lockout = await ctx.http().post('/v1/security/dashboard-ip').set(at(office)).send({ cidr: '192.0.2.0/24' });
    expect(lockout.status).toBe(409);
    const added = await ctx.http().post('/v1/security/dashboard-ip').set(at(office)).send({ cidr: '198.51.100.0/24', label: 'Office' });
    expect(added.status).toBe(201);
    expect(added.body.data.cidr).toBe('198.51.100.0/24');
    const list = await ctx.http().get('/v1/security/dashboard-ip').set(at(office));
    expect(list.body.data).toMatchObject({ your_ip: office, rules: [{ label: 'Office' }] });

    // Same session from another network.
    expect((await ctx.http().get('/v1/auth/me').set(at(home))).body.error.code).toBe('IP_NOT_ALLOWED');

    // Correct password from outside: refused before any second-factor challenge; recorded.
    const outside = await login(ctx, user.email, SEED_PASSWORD, home);
    expect(outside.res.status).toBe(403);
    expect(outside.res.body.error.code).toBe('IP_NOT_ALLOWED');
    expect(outside.res.body.data).toBeUndefined();
    expect(await ctx.prisma.loginEvent.count({ where: { userId: user.id, outcome: 'IP_NOT_ALLOWED' } })).toBe(1);

    // Refresh from outside fails without burning the token; from the office it works.
    const refreshFrom = (ip: string) => ctx.http().post('/v1/auth/refresh').set('X-Forwarded-For', ip).set('X-Pay2All-CSRF', '1').set('Origin', ORIGIN).set('Cookie', `p2a_rt=${enrolled.refresh}`);
    expect((await refreshFrom(home)).body.error.code).toBe('IP_NOT_ALLOWED');
    const fromOffice = await refreshFrom(office);
    expect(fromOffice.status).toBe(200);
    expect(extractRefreshCookie(fromOffice)).toBeTruthy();

    // Inside: normal sign-in (password → TOTP).
    const inside = await login(ctx, user.email, SEED_PASSWORD, office);
    expect(inside.res.body.data.status).toBe('MFA_REQUIRED');

    // Other organizations are unaffected.
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/auth/me').set({ ...bearer(other.owner), 'X-Forwarded-For': home })).status).toBe(200);

    // Removing the last entry opens access again.
    const del = await ctx.http().delete(`/v1/security/dashboard-ip/${added.body.data.id}`).set(at(office));
    expect(del.status).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: { in: ['security.dashboard_ip.added', 'security.dashboard_ip.removed'] }, actorId: user.id } })).toBe(2);
  });

  it('is managed only by users who can manage the team', async () => {
    const m = await createApprovedMerchant(ctx);
    const viewer = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: m.id });
    const token = (await login(ctx, viewer.email)).accessToken!;
    expect((await ctx.http().post('/v1/security/dashboard-ip').set(bearer(token)).send({ cidr: '198.51.100.0/24' })).status).toBe(403);
  });
});
