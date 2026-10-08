import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { newId, signApiRequest } from '@pay2all/auth';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommissionsService } from '../src/modules/commissions/commissions.service';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext, signIn } from './helpers';

let ctx: TestContext;
let admin: string; // platform ADMIN
let finance: string;

const key = () => `k_${randomUUID().replace(/-/g, '')}`;

/** Signed server-to-server request (docs/API.md). */
function signed(publicKey: string, secret: string, method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}, opts: { ts?: number; tamper?: boolean } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const sig = signApiRequest(secret, ts, nonce, method, path, raw);
  const req = method === 'GET' ? ctx.http().get(path) : ctx.http().post(path).set('Content-Type', 'application/json');
  req.set('X-Pay2All-Key', publicKey).set('X-Pay2All-Timestamp', String(ts)).set('X-Pay2All-Nonce', nonce).set('X-Pay2All-Signature', sig).set('X-Forwarded-For', extra['X-Forwarded-For'] ?? '203.0.113.7');
  for (const [k, v] of Object.entries(extra)) req.set(k, v);
  return { req: method === 'GET' ? req : req.send(opts.tamper ? raw.replace('"', '" ') : raw), sig, ts, raw, nonce };
}

async function newKey(token: string, body: Record<string, unknown> = { name: 'Server' }) {
  const res = await ctx.http().post('/v1/developers/api-keys').set(bearer(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { key_id: string; public_key: string; secret: string; permissions: string[] };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  finance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('API keys', () => {
  it('shows the secret once, stores it encrypted, and never grants more than the creator holds', async () => {
    const m = await createApprovedMerchant(ctx);
    const k = await newKey(m.owner, { name: 'Checkout server' });
    expect(k.public_key).toMatch(/^pk_test_[A-Za-z0-9]{28}$/);
    expect(k.secret).toMatch(/^sk_test_/);
    const row = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: k.key_id } });
    expect(row.secretEncrypted).not.toContain(k.secret.slice(8));
    const list = await ctx.http().get('/v1/developers/api-keys').set(bearer(m.owner));
    expect(JSON.stringify(list.body)).not.toContain(k.secret);
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany({ where: { resourceId: k.key_id } }))).not.toContain(k.secret);

    const dev = (await signIn(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_DEVELOPER', organizationId: m.id })).email)).accessToken!;
    const tooMuch = await ctx.http().post('/v1/developers/api-keys').set(bearer(dev)).send({ name: 'Too much', permissions: ['payout.create'] });
    expect(tooMuch.status).toBe(403);
  });

  it('authenticates signed requests and attributes actions to the key', async () => {
    const m = await createApprovedMerchant(ctx);
    const k = await newKey(m.owner);
    const list = signed(k.public_key, k.secret, 'GET', '/v1/payments?limit=5');
    expect((await list.req).status).toBe(200);
    const body = { merchant_order_id: `api_${randomUUID().slice(0, 10)}`, amount: '250.00', method: 'UPI' };
    const created = await signed(k.public_key, k.secret, 'POST', '/v1/payments', body, { 'Idempotency-Key': key() }).req;
    expect(created.status).toBe(201);
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: created.body.data.payment_id } });
    expect(p).toMatchObject({ merchantId: m.id, createdById: k.key_id });
    const balances = await signed(k.public_key, k.secret, 'GET', `/v1/ledger/balances?merchant_id=${m.id}`).req;
    expect(balances.status).toBe(200);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/ledger/balances').req).status).toBe(200); // own balances by default
    expect(created.headers['ratelimit-limit']).toBe('600');
  });

  it('rejects tampering, stale timestamps, replays, unknown/revoked keys and dashboard-only routes', async () => {
    const m = await createApprovedMerchant(ctx);
    const k = await newKey(m.owner);
    const body = { merchant_order_id: `api_${randomUUID().slice(0, 10)}`, amount: '10.00', method: 'UPI' };
    expect((await signed(k.public_key, k.secret, 'POST', '/v1/payments', body, { 'Idempotency-Key': key() }, { tamper: true }).req).status).toBe(401);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/payments', undefined, {}, { ts: Math.floor(Date.now() / 1000) - 600 }).req).status).toBe(401);
    // Signature over a different path doesn't verify.
    const s = signed(k.public_key, k.secret, 'GET', '/v1/payments');
    expect((await ctx.http().get('/v1/payouts').set('X-Pay2All-Key', k.public_key).set('X-Pay2All-Timestamp', String(s.ts)).set('X-Pay2All-Nonce', s.nonce).set('X-Pay2All-Signature', s.sig)).status).toBe(401);
    // Replay: the same signed request twice.
    const first = signed(k.public_key, k.secret, 'GET', '/v1/refunds');
    expect((await first.req).status).toBe(200);
    const replay = await ctx.http().get('/v1/refunds').set('X-Pay2All-Key', k.public_key).set('X-Pay2All-Timestamp', String(first.ts)).set('X-Pay2All-Nonce', first.nonce).set('X-Pay2All-Signature', first.sig);
    expect(replay.status).toBe(401);
    // Identical requests with fresh nonces are fine (polling).
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/refunds').req).status).toBe(200);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/refunds').req).status).toBe(200);
    // No nonce → rejected.
    const noNonce = signed(k.public_key, k.secret, 'GET', '/v1/refunds');
    expect((await ctx.http().get('/v1/refunds').set('X-Pay2All-Key', k.public_key).set('X-Pay2All-Timestamp', String(noNonce.ts)).set('X-Pay2All-Signature', noNonce.sig)).status).toBe(401);
    expect((await signed('pk_test_' + 'A'.repeat(28), k.secret, 'GET', '/v1/payments').req).status).toBe(401);
    // Dashboard-only surfaces can't be driven by a key.
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/developers/api-keys').req).status).toBe(403);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/auth/me').req).status).toBe(403);
    expect((await signed(k.public_key, k.secret, 'POST', '/v1/webhooks/endpoints', { url: 'https://x.example/h' }).req).status).toBe(403);
    await ctx.http().post(`/v1/developers/api-keys/${k.key_id}/revoke`).set(bearer(m.owner)).expect(200);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/payments').req).status).toBe(401);
  });

  it('respects key permissions, rotation overlap, IP allowlists and per-key rate limits', async () => {
    const m = await createApprovedMerchant(ctx);
    const readOnly = await newKey(m.owner, { name: 'Reporting', permissions: ['payin.read'], rate_limit_per_minute: 3 });
    expect((await signed(readOnly.public_key, readOnly.secret, 'POST', '/v1/payments', { merchant_order_id: 'x1', amount: '1.00', method: 'UPI' }, { 'Idempotency-Key': key() }).req).status).toBe(403);
    expect((await signed(readOnly.public_key, readOnly.secret, 'GET', '/v1/payments').req).status).toBe(200);
    expect((await signed(readOnly.public_key, readOnly.secret, 'GET', '/v1/payments?limit=2').req).status).toBe(200);
    const limited = await signed(readOnly.public_key, readOnly.secret, 'GET', '/v1/payments?limit=3').req;
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    const k = await newKey(m.owner);
    const rotated = await ctx.http().post(`/v1/developers/api-keys/${k.key_id}/rotate`).set(bearer(m.owner)).send({ overlap_hours: 24 });
    expect(rotated.status).toBe(200);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/payments').req).status).toBe(200); // old key still works in the overlap
    expect((await signed(rotated.body.data.public_key, rotated.body.data.secret, 'GET', '/v1/payments').req).status).toBe(200);
    await ctx.prisma.apiKey.update({ where: { id: k.key_id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/payments').req).status).toBe(401);

    const fresh = rotated.body.data as { public_key: string; secret: string };
    await ctx.http().post('/v1/developers/ip-allowlist').set(bearer(m.owner)).send({ cidr: '198.51.100.0/24', label: 'Prod servers' }).expect(201);
    const blocked = await signed(fresh.public_key, fresh.secret, 'GET', '/v1/payments', undefined, { 'X-Forwarded-For': '203.0.113.9' }).req;
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('IP_NOT_ALLOWED');
    expect((await signed(fresh.public_key, fresh.secret, 'GET', '/v1/payments', undefined, { 'X-Forwarded-For': '198.51.100.20' }).req).status).toBe(200);
    expect((await ctx.http().post('/v1/developers/ip-allowlist').set(bearer(m.owner)).send({ cidr: '10.0.0.0/4' })).status).toBe(400);
  });

  it('logs requests (no bodies) and summarises usage', async () => {
    const m = await createApprovedMerchant(ctx);
    const k = await newKey(m.owner);
    await signed(k.public_key, k.secret, 'GET', '/v1/payments').req;
    await signed(k.public_key, k.secret, 'POST', '/v1/payments', { merchant_order_id: 'bad', amount: 5, method: 'UPI' }, { 'Idempotency-Key': key() }).req;
    await new Promise((r) => setTimeout(r, 300)); // logs are written on response finish
    const logs = await ctx.http().get('/v1/developers/api-logs').set(bearer(m.owner));
    expect(logs.body.data.map((l: { status_code: number }) => l.status_code).sort()).toEqual([200, 400]);
    expect(logs.body.data.find((l: { status_code: number }) => l.status_code === 400).error_code).toBe('INVALID_REQUEST');
    const usage = await ctx.http().get('/v1/developers/api-usage').query({ days: 7 }).set(bearer(m.owner));
    expect(usage.body.data.totals).toMatchObject({ requests: 2, errors: 1 });
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/developers/api-logs').set(bearer(other.owner))).body.data).toHaveLength(0);
  });
});

describe('API partners', () => {
  it('act for their own merchants only, via a verified merchant header', async () => {
    const partnerId = newId('organization');
    const platform = await orgBySlug(ctx, 'pay2all');
    await ctx.prisma.organization.create({ data: { id: partnerId, slug: `ptn-${partnerId.slice(-8).toLowerCase()}`, name: 'Acme Platform API', type: 'API_PARTNER', parentId: platform.id } });
    const partner = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'API_PARTNER', organizationId: partnerId })).email)).accessToken;
    const created = await ctx.http().post('/v1/merchants').set(bearer(partner)).send({ display_name: 'Partner Shop' });
    expect(created.status).toBe(201);
    const childId = created.body.data.id as string;
    expect((await ctx.prisma.organization.findUniqueOrThrow({ where: { id: childId } })).parentId).toBe(partnerId);
    await ctx.prisma.merchant.update({ where: { id: childId }, data: { status: 'APPROVED', payinEnabled: true } });
    const k = await newKey(partner, { name: 'Platform backend' });

    const body = { merchant_order_id: `ptn_${randomUUID().slice(0, 10)}`, amount: '120.00', method: 'UPI' };
    const ok = await signed(k.public_key, k.secret, 'POST', '/v1/payments', body, { 'Idempotency-Key': key(), 'X-Pay2All-Merchant': childId }).req;
    expect(ok.status).toBe(201);
    expect(ok.body.data.merchant_id).toBe(childId);
    // Without a merchant, a partner can't create payments for itself.
    expect((await signed(k.public_key, k.secret, 'POST', '/v1/payments', { ...body, merchant_order_id: 'p2' }, { 'Idempotency-Key': key() }).req).status).toBe(403);
    // Someone else's merchant is invisible.
    const stranger = await createApprovedMerchant(ctx);
    expect((await signed(k.public_key, k.secret, 'GET', '/v1/payments', undefined, { 'X-Pay2All-Merchant': stranger.id }).req).status).toBe(404);
    // A merchant key can't use the partner header.
    const mk = await newKey(stranger.owner);
    expect((await signed(mk.public_key, mk.secret, 'GET', '/v1/payments', undefined, { 'X-Pay2All-Merchant': childId }).req).status).toBe(403);
    // The partner dashboard sees its merchant's payments; the API log records the partner.
    const dash = await ctx.http().get('/v1/payments').query({ merchant_id: childId }).set(bearer(partner));
    expect(dash.body.data.map((p: { payment_id: string }) => p.payment_id)).toContain(ok.body.data.payment_id);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ctx.prisma.apiRequestLog.count({ where: { organizationId: childId, partnerId } })).toBeGreaterThanOrEqual(1);
  });
});

describe('reseller rate cards and commissions', () => {
  async function newReseller() {
    const platform = await orgBySlug(ctx, 'pay2all');
    const id = newId('organization');
    await ctx.prisma.organization.create({ data: { id, slug: `rs-${id.slice(-8).toLowerCase()}`, name: `Reseller ${id.slice(-5)}`, type: 'RESELLER', parentId: platform.id } });
    const token = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'RESELLER', organizationId: id })).email)).accessToken;
    const mid = newId('organization');
    await ctx.prisma.organization.create({ data: { id: mid, slug: `rm-${mid.slice(-8).toLowerCase()}`, name: 'Reseller Merchant', type: 'MERCHANT', parentId: id } });
    await ctx.prisma.merchant.create({ data: { id: mid, resellerId: id, status: 'APPROVED', payinEnabled: true, payoutEnabled: true } });
    await ctx.prisma.merchantProfile.create({ data: { merchantId: mid, displayName: 'Reseller Merchant' } });
    await ctx.prisma.merchantKyc.create({ data: { merchantId: mid } });
    const owner = (await signIn(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: mid })).email)).accessToken!;
    return { id, token, merchantId: mid, owner };
  }

  it('resellers price their own merchants, never below wholesale, and cannot touch platform pricing', async () => {
    const r = await newReseller();
    const platformPlan = await ctx.prisma.pricingPlan.findFirstOrThrow({ where: { kind: 'MERCHANT', isDefault: true, status: 'ACTIVE', ownerOrgId: (await orgBySlug(ctx, 'pay2all')).id } });
    // Regression: archiving or assigning someone else's plan is impossible.
    expect((await ctx.http().post(`/v1/pricing/plans/${platformPlan.id}/archive`).set(bearer(r.token))).status).toBe(404);
    expect((await ctx.http().post('/v1/pricing/assignments').set(bearer(r.token)).send({ plan_id: platformPlan.id, subject_type: 'MERCHANT', subject_id: r.merchantId })).status).toBe(404);
    expect((await ctx.prisma.pricingPlan.findUniqueOrThrow({ where: { id: platformPlan.id } })).status).toBe('ACTIVE');

    const below = await ctx.http().post('/v1/pricing/plans').set(bearer(r.token)).send({ name: 'Too cheap', kind: 'MERCHANT', rules: [{ service: 'PAYIN', charge_type: 'PERCENTAGE', rate: '0.10' }] });
    expect(below.status).toBe(400);
    expect(below.body.error.message).toMatch(/below your wholesale/);
    expect((await ctx.http().post('/v1/pricing/plans').set(bearer(r.token)).send({ name: 'Wholesale try', kind: 'WHOLESALE', rules: [{ service: 'PAYIN', charge_type: 'PERCENTAGE', rate: '0.50' }] })).status).toBe(403);
    const card = await ctx.http().post('/v1/pricing/plans').set(bearer(r.token)).send({ name: 'Premium', kind: 'MERCHANT', rules: [{ service: 'PAYIN', charge_type: 'PERCENTAGE', rate: '0.25' }, { service: 'PAYOUT', charge_type: 'FLAT', flat_fee: '6.00' }] });
    expect(card.status).toBe(201);
    const nimbus = await orgBySlug(ctx, 'nimbus-software'); // not this reseller's merchant
    expect((await ctx.http().post('/v1/pricing/assignments').set(bearer(r.token)).send({ plan_id: card.body.data.id, subject_type: 'MERCHANT', subject_id: nimbus.id })).status).toBe(404);
    await ctx.http().post('/v1/pricing/assignments').set(bearer(r.token)).send({ plan_id: card.body.data.id, subject_type: 'MERCHANT', subject_id: r.merchantId }).expect(201);
    const plans = await ctx.http().get('/v1/pricing/plans').set(bearer(r.token));
    expect(plans.body.data.map((p: { kind: string }) => p.kind).sort()).toEqual(['MERCHANT', 'WHOLESALE']);

    // ₹1,000 at 0.25%: fee 2.50, wholesale 1.40 → reseller margin 1.10 accrues once money moves.
    const pay = await ctx.http().post('/v1/payments').set(bearer(r.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `rm_${randomUUID().slice(0, 8)}`, amount: '1000.00', method: 'UPI' });
    expect(pay.body.data.fee).toBe('2.50');
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.payment_id } });
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
    const secret = (await ctx.app.get(ProviderRegistryService).context(provider)).credentials.webhook_secret!;
    const cb = JSON.stringify({ event_id: `ev_${randomUUID()}`, type: 'payment.status', data: { reference: p.id, provider_order_id: p.providerOrderId, status: 'SUCCESS', amount_minor: '100000' } });
    await ctx.http().post(`/v1/webhooks/providers/${provider.code}`).set('Content-Type', 'application/json').set('X-Mock-Signature', createHmac('sha256', secret).update(cb).digest('hex')).send(cb).expect(200);

    const svc = ctx.app.get(CommissionsService);
    await svc.accrueDue();
    await svc.accrueDue(); // idempotent
    const payable = await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: Accounts.resellerCommission(r.id) } });
    expect(payable.balanceMinor).toBe(110n);
    expect(await ctx.prisma.ledgerJournal.count({ where: { idempotencyKey: `commission:${p.id}` } })).toBe(1);

    const earnings = await ctx.http().get(`/v1/resellers/${r.id}/earnings`).set(bearer(r.token));
    expect(earnings.body.data).toMatchObject({ payable_balance: '1.10', accrued_lifetime: '1.10' });
    expect(earnings.body.data.by_merchant[0]).toMatchObject({ merchant_id: r.merchantId, payin_count: 1, payin_margin: '1.10' });
    const other = await newReseller();
    expect((await ctx.http().get(`/v1/resellers/${r.id}/earnings`).set(bearer(other.token))).status).toBe(404);
    expect((await ctx.http().get(`/v1/resellers/${r.id}/earnings`).set(bearer(r.owner))).status).toBe(404);

    expect((await ctx.http().post(`/v1/resellers/${r.id}/commission-payouts`).set(bearer(finance)).send({ amount: '2.00', utr: 'CMSN00000001' })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    const paid = await ctx.http().post(`/v1/resellers/${r.id}/commission-payouts`).set(bearer(finance)).send({ amount: '1.10', utr: 'CMSN00000002', period_note: 'October' });
    expect(paid.status).toBe(201);
    expect((await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: Accounts.resellerCommission(r.id) } })).balanceMinor).toBe(0n);
    expect((await ctx.http().post(`/v1/resellers/${r.id}/commission-payouts`).set(bearer(r.token)).send({ amount: '1.00', utr: 'CMSN00000003' })).status).toBe(403);
    void admin;
  });
});
