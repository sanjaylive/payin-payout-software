import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext, uniqueEmail } from './helpers';

let ctx: TestContext;
let sharma: { id: string };
let kirana: { id: string };
let nimbus: { id: string };
let reseller: { id: string };
let platform: { id: string };
let sharmaOwnerToken: string;
let kiranaOwnerToken: string;
let resellerToken: string;
let adminToken: string;

beforeAll(async () => {
  ctx = await createTestContext();
  sharma = await orgBySlug(ctx, 'sharma-electronics');
  kirana = await orgBySlug(ctx, 'kirana-fresh');
  nimbus = await orgBySlug(ctx, 'nimbus-software');
  reseller = await orgBySlug(ctx, 'acme-partners');
  platform = await orgBySlug(ctx, 'pay2all');
  sharmaOwnerToken = (await login(ctx, 'owner@sharma-electronics.local')).accessToken!;
  kiranaOwnerToken = (await login(ctx, 'owner@kirana-fresh.local')).accessToken!;
  const resellerUser = await createUser(ctx, { roleKey: 'RESELLER', organizationId: reseller.id });
  resellerToken = (await loginWithMfaEnrollment(ctx, resellerUser.email)).accessToken;
  const admin = await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id });
  adminToken = (await loginWithMfaEnrollment(ctx, admin.email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('cross-tenant isolation', () => {
  it("merchant A cannot read merchant B's organization (404, not 403)", async () => {
    const res = await ctx.http().get(`/v1/organizations/${kirana.id}`).set(bearer(sharmaOwnerToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it("merchant A cannot read merchant B's users", async () => {
    const kiranaOwner = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'owner@kirana-fresh.local' } });
    const res = await ctx.http().get(`/v1/users/${kiranaOwner.id}`).set(bearer(sharmaOwnerToken));
    expect(res.status).toBe(404);
  });

  it('user listing only returns members of the caller’s organization', async () => {
    const res = await ctx.http().get('/v1/users?limit=100').set(bearer(sharmaOwnerToken));
    expect(res.status).toBe(200);
    for (const u of res.body.data as { memberships: { organization_id: string }[] }[]) {
      expect(u.memberships.every((m) => m.organization_id === sharma.id)).toBe(true);
    }
    const emails = (res.body.data as { email: string }[]).map((u) => u.email);
    expect(emails).not.toContain('owner@kirana-fresh.local');
  });

  it('filtering by another tenant’s organization_id is rejected as not found', async () => {
    const res = await ctx.http().get(`/v1/users?organization_id=${kirana.id}`).set(bearer(sharmaOwnerToken));
    expect(res.status).toBe(404);
  });

  it('reseller sees its own merchants but not merchants of the platform or other resellers', async () => {
    const res = await ctx.http().get('/v1/organizations?limit=100').set(bearer(resellerToken));
    const ids = (res.body.data as { id: string }[]).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([reseller.id, sharma.id, kirana.id]));
    expect(ids).not.toContain(nimbus.id);
    expect(ids).not.toContain(platform.id);
    expect((await ctx.http().get(`/v1/organizations/${nimbus.id}`).set(bearer(resellerToken))).status).toBe(404);
  });

  it('platform staff see every organization', async () => {
    const res = await ctx.http().get('/v1/organizations?limit=100').set(bearer(adminToken));
    const ids = (res.body.data as { id: string }[]).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([platform.id, reseller.id, sharma.id, kirana.id, nimbus.id]));
  });

  it('audit logs are tenant scoped', async () => {
    const res = await ctx.http().get('/v1/audit-logs?limit=100').set(bearer(kiranaOwnerToken));
    expect(res.status).toBe(200);
    for (const row of res.body.data as { organization_id: string | null }[]) expect(row.organization_id).toBe(kirana.id);
  });
});

describe('permission enforcement', () => {
  it('merchant users cannot call platform-only endpoints', async () => {
    const res = await ctx.http().post('/v1/organizations').set(bearer(sharmaOwnerToken)).send({ name: 'Rogue Org', type: 'MERCHANT' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('viewers cannot manage users', async () => {
    const viewer = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: sharma.id });
    const token = (await login(ctx, viewer.email)).accessToken!;
    const res = await ctx.http().post('/v1/users').set(bearer(token)).send({ name: 'X Y', email: uniqueEmail(), role_key: 'MERCHANT_VIEWER' });
    expect(res.status).toBe(403);
  });

  it('requires authentication on protected routes', async () => {
    const res = await ctx.http().get('/v1/users');
    expect(res.status).toBe(401);
  });

  it('rejects tampered access tokens', async () => {
    const [h, p] = sharmaOwnerToken.split('.');
    const res = await ctx.http().get('/v1/auth/me').set(bearer(`${h}.${p}.invalidsignature`));
    expect(res.status).toBe(401);
  });
});

describe('role assignment and privilege escalation', () => {
  it('merchant owner can invite a team member into their own org', async () => {
    const email = uniqueEmail('invitee');
    const res = await ctx.http().post('/v1/users').set(bearer(sharmaOwnerToken)).send({ name: 'New Dev', email, role_key: 'MERCHANT_DEVELOPER' });
    expect(res.status).toBe(201);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
    expect(user.status).toBe('INVITED');
    expect(user.memberships[0]!.organizationId).toBe(sharma.id);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'user.invited', resourceId: user.id } })).toBe(1);
  });

  it('merchant owner cannot grant a platform role or target another tenant', async () => {
    const platformRole = await ctx.http().post('/v1/users').set(bearer(sharmaOwnerToken)).send({ name: 'Bad Actor', email: uniqueEmail(), role_key: 'SUPER_ADMIN' });
    expect(platformRole.status).toBe(400);
    const otherTenant = await ctx
      .http()
      .post('/v1/users')
      .set(bearer(sharmaOwnerToken))
      .send({ name: 'Bad Actor', email: uniqueEmail(), role_key: 'MERCHANT_VIEWER', organization_id: kirana.id });
    expect(otherTenant.status).toBe(404);
  });

  it('a reseller cannot grant a merchant role carrying permissions the reseller lacks', async () => {
    const res = await ctx
      .http()
      .post('/v1/users')
      .set(bearer(resellerToken))
      .send({ name: 'Escalation Attempt', email: uniqueEmail(), role_key: 'MERCHANT_OWNER', organization_id: sharma.id });
    expect(res.status).toBe(403);
  });

  it('the last owner of an organization cannot be removed', async () => {
    const kiranaOwner = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'owner@kirana-fresh.local' } });
    const secondAdmin = await createUser(ctx, { roleKey: 'MERCHANT_ADMIN', organizationId: kirana.id });
    const token = (await login(ctx, secondAdmin.email)).accessToken!;
    const res = await ctx.http().delete(`/v1/users/${kiranaOwner.id}/roles/MERCHANT_OWNER`).set(bearer(token));
    expect(res.status).toBe(403);
  });

  it('revoking a role takes effect on the next request (permission cache invalidated)', async () => {
    const dev = await createUser(ctx, { roleKey: 'MERCHANT_ADMIN', organizationId: sharma.id });
    const devToken = (await login(ctx, dev.email)).accessToken!;
    expect((await ctx.http().get('/v1/users').set(bearer(devToken))).status).toBe(200);
    const revoke = await ctx.http().delete(`/v1/users/${dev.id}/roles/MERCHANT_ADMIN`).set(bearer(sharmaOwnerToken));
    expect(revoke.status).toBe(200);
    expect((await ctx.http().get('/v1/users').set(bearer(devToken))).status).toBe(401);
  });

  it('tenants cannot disable a user account globally', async () => {
    const viewer = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: sharma.id });
    const res = await ctx.http().patch(`/v1/users/${viewer.id}/status`).set(bearer(sharmaOwnerToken)).send({ status: 'DISABLED', reason: 'testing tenant limits' });
    expect(res.status).toBe(403);
  });
});

describe('organization lifecycle', () => {
  it('suspending an organization blocks its members immediately and is audited with a reason', async () => {
    const created = await ctx.http().post('/v1/organizations').set(bearer(adminToken)).send({ name: 'Suspend Me Traders', type: 'MERCHANT', parent_id: reseller.id });
    expect(created.status).toBe(201);
    const orgId = created.body.data.id as string;
    expect(created.body.data.parent_id).toBe(reseller.id);

    const owner = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: orgId });
    const ownerToken = (await login(ctx, owner.email)).accessToken!;
    expect((await ctx.http().get('/v1/auth/me').set(bearer(ownerToken))).status).toBe(200);

    const suspend = await ctx.http().patch(`/v1/organizations/${orgId}/status`).set(bearer(adminToken)).send({ status: 'SUSPENDED', reason: 'KYC documents expired' });
    expect(suspend.status).toBe(200);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(ownerToken))).status).toBe(403);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'organization.suspended', resourceId: orgId } });
    expect(audit.metadata).toMatchObject({ reason: 'KYC documents expired' });
    expect(audit.oldValue).toMatchObject({ status: 'ACTIVE' });
    expect(audit.newValue).toMatchObject({ status: 'SUSPENDED' });
    expect(audit.requestId).toBe(suspend.headers['x-request-id']);
  });

  it('cannot create a merchant under another merchant', async () => {
    const res = await ctx.http().post('/v1/organizations').set(bearer(adminToken)).send({ name: 'Nested Merchant', type: 'MERCHANT', parent_id: sharma.id });
    expect(res.status).toBe(400);
  });
});
