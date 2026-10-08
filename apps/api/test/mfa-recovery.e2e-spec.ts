import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestContext, createUser, login, orgBySlug, SEED_PASSWORD, type TestContext, signIn } from './helpers';
import { generateTotpCode } from '@pay2all/auth';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
});

async function enroll(email: string) {
  const first = await login(ctx, email);
  const setup = await ctx.http().post('/v1/auth/mfa/totp/setup').set(bearer(first.accessToken!));
  const enable = await ctx.http().post('/v1/auth/mfa/totp/enable').set(bearer(first.accessToken!)).send({ code: await generateTotpCode(setup.body.data.secret) });
  return { token: enable.body.data.access_token as string, codes: enable.body.data.recovery_codes as string[], secret: setup.body.data.secret as string };
}

describe('MFA recovery codes', () => {
  it('issues 10 single-use codes that work as a second factor exactly once', async () => {
    const platform = await orgBySlug(ctx, 'pay2all');
    const user = await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id });
    const { codes } = await enroll(user.email);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const stored = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(JSON.stringify(stored)).not.toContain(codes[0]!);

    const challenge = (await login(ctx, user.email)).res.body.data.mfa_token as string;
    const ok = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: challenge, recovery_code: codes[0]!.toLowerCase() });
    expect(ok.status).toBe(200);

    const again = (await login(ctx, user.email)).res.body.data.mfa_token as string;
    const reuse = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: again, recovery_code: codes[0] });
    expect(reuse.body.error.code).toBe('MFA_INVALID_CODE');
    const me = await ctx.http().get('/v1/auth/me').set(bearer(ok.body.data.access_token));
    expect(me.body.data.mfa.recovery_codes_remaining).toBe(9);
  });

  it('rejects requests carrying both a TOTP code and a recovery code', async () => {
    const res = await ctx.http().post('/v1/auth/mfa/verify').send({ mfa_token: 'x'.repeat(20), code: '123456', recovery_code: 'ABCDE-FGH23' });
    expect(res.status).toBe(400);
  });

  it('lets platform admins reset a user’s MFA (audited, signs them out)', async () => {
    const platform = await orgBySlug(ctx, 'pay2all');
    const target = await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id });
    const enrolled = await enroll(target.email);
    const admin = await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id });
    const adminToken = (await enroll(admin.email)).token;

    const reset = await ctx.http().post(`/v1/users/${target.id}/mfa/reset`).set(bearer(adminToken)).send({ reason: 'Lost phone and recovery codes' });
    expect(reset.status).toBe(201);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(enrolled.token))).status).toBe(401);
    const next = await login(ctx, target.email, SEED_PASSWORD);
    expect(next.res.body.data.status).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.mfa.admin_reset', resourceId: target.id } })).toBe(1);

    // Merchant owners cannot reset anyone's MFA.
    const sharma = await orgBySlug(ctx, 'sharma-electronics');
    const owner = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: sharma.id });
    const ownerToken = (await signIn(ctx, owner.email)).accessToken!;
    const viewer = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: sharma.id });
    expect((await ctx.http().post(`/v1/users/${viewer.id}/mfa/reset`).set(bearer(ownerToken)).send({ reason: 'trying it' })).status).toBe(403);
  });
});
