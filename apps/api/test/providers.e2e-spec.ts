import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@pay2all/auth';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { bearer, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext, signIn } from './helpers';

let ctx: TestContext;
let opsToken: string;
let sharmaId: string;
let nimbusId: string;
const providerId = async (code: string) => (await ctx.prisma.provider.findUniqueOrThrow({ where: { code } })).id;

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  opsToken = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
  sharmaId = (await orgBySlug(ctx, 'sharma-electronics')).id;
  nimbusId = (await orgBySlug(ctx, 'nimbus-software')).id;
});

afterAll(async () => {
  await ctx.app.close();
});

const simulate = (merchantId: string, amount: string, method = 'IMPS') =>
  ctx.http().post('/v1/routing/simulate').set(bearer(opsToken)).send({ service: 'PAYOUT', merchant_id: merchantId, amount, method });
const order = (res: { body: { data: { candidates: { provider_code: string }[] } } }) => res.body.data.candidates.map((c) => c.provider_code);

describe('routing (seeded spec examples)', () => {
  it('sends ₹0–₹5,000 to Provider 1 and larger payouts to Provider 2, each with the other as fallback', async () => {
    expect(order(await simulate(nimbusId, '5000.00'))).toEqual(['mock-payout', 'mock-payout-2']);
    expect(order(await simulate(nimbusId, '5000.01'))).toEqual(['mock-payout-2', 'mock-payout']);
  });

  it('explains why a merchant-specific rule to a disabled provider was skipped', async () => {
    const res = await simulate(sharmaId, '100.00');
    expect(order(res)).toEqual(['mock-payout', 'mock-payout-2']);
    const skipped = (res.body.data.evaluations as { provider_code: string; selected: boolean; reasons: string[] }[]).find((e) => e.provider_code === 'provider-a')!;
    expect(skipped).toMatchObject({ selected: false, reasons: ['provider disabled'] });
  });

  it('fails over to Provider 2 while Provider 1 is in maintenance', async () => {
    const p1 = await providerId('mock-payout');
    await ctx.http().patch(`/v1/providers/${p1}/status`).set(bearer(opsToken)).send({ status: 'MAINTENANCE', reason: 'Bank maintenance window' }).expect(200);
    expect(order(await simulate(nimbusId, '100.00'))).toEqual(['mock-payout-2']);
    await ctx.http().patch(`/v1/providers/${p1}/status`).set(bearer(opsToken)).send({ status: 'ACTIVE', reason: 'Maintenance over' }).expect(200);
    expect(order(await simulate(nimbusId, '100.00'))).toEqual(['mock-payout', 'mock-payout-2']);
    const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p1 } });
    expect(p.statusSource).toBe('AUTO'); // ACTIVE hands control back to the health breaker
  });

  it('respects capabilities (RTGS only on Provider 2)', async () => {
    expect(order(await simulate(nimbusId, '300000.00', 'RTGS'))).toEqual(['mock-payout-2']);
  });
});

describe('provider management', () => {
  it('stores credentials write-only: encrypted at rest, fingerprints only in responses and audit', async () => {
    // A closed local port: connection refused before anything is sent.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const created = await ctx.http().post('/v1/providers').set(bearer(opsToken)).send({ code: 'test-psp', name: 'Test PSP', kind: 'PAYOUT', adapter: 'provider-b', config: { base_url: `http://127.0.0.1:${port}` } });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('DISABLED');
    const id = created.body.data.id as string;

    // Can't enable without credentials.
    expect((await ctx.http().patch(`/v1/providers/${id}/status`).set(bearer(opsToken)).send({ status: 'ACTIVE', reason: 'try enabling' })).status).toBe(400);
    // Unknown credential keys are rejected.
    expect((await ctx.http().put(`/v1/providers/${id}/credentials`).set(bearer(opsToken)).send({ environment: 'TEST', values: { password: 'x' } })).status).toBe(400);

    const secret = 'tok_super_secret_value_9f3a';
    const put = await ctx.http().put(`/v1/providers/${id}/credentials`).set(bearer(opsToken)).send({ environment: 'TEST', values: { access_token: secret } });
    expect(put.body.data.fingerprints).toEqual({ access_token: '…9f3a' });
    const get = await ctx.http().get(`/v1/providers/${id}`).set(bearer(opsToken));
    expect(JSON.stringify(get.body)).not.toContain(secret);
    const row = await ctx.prisma.providerCredential.findFirstOrThrow({ where: { providerId: id } });
    expect(row.secretEncrypted).not.toContain(secret);
    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: id } });
    expect(JSON.stringify(audits)).not.toContain(secret);

    // Decrypts correctly for the adapter at call time.
    const registry = ctx.app.get(ProviderRegistryService);
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id } });
    expect((await registry.context(provider)).credentials).toEqual({ access_token: secret });

    // Connection test against an unreachable endpoint is classified, not thrown.
    const test = await ctx.http().post(`/v1/providers/${id}/test`).set(bearer(opsToken));
    expect(test.body.data).toMatchObject({ ok: false, error_kind: 'NOT_ATTEMPTED' });
  });

  it('refuses secrets in plain config and unknown adapters', async () => {
    expect((await ctx.http().post('/v1/providers').set(bearer(opsToken)).send({ code: 'leaky', name: 'Leaky', kind: 'PAYOUT', adapter: 'mock', config: { api_secret: 'oops' } })).status).toBe(400);
    expect((await ctx.http().post('/v1/providers').set(bearer(opsToken)).send({ code: 'nope', name: 'Nope', kind: 'PAYOUT', adapter: 'not-real' })).status).toBe(400);
    expect((await ctx.http().post('/v1/providers').set(bearer(opsToken)).send({ code: 'wrongkind', name: 'Wrong', kind: 'PAYIN', adapter: 'provider-b' })).status).toBe(400);
  });

  it('runs a live health check through the mock adapter and reports metrics', async () => {
    // A dedicated provider: shared sandbox providers accumulate samples from other suites.
    const id = newId('provider');
    await ctx.prisma.provider.create({ data: { id, code: `hm-${id.slice(-8).toLowerCase()}`, name: 'Health metrics test', kind: 'PAYIN', adapter: 'mock', status: 'ACTIVE', statusSource: 'AUTO', capabilities: { payin_methods: ['UPI_QR'] } } });
    const res = await ctx.http().post(`/v1/providers/${id}/test`).set(bearer(opsToken));
    expect(res.body.data.ok).toBe(true);
    const registry = ctx.app.get(ProviderRegistryService);
    for (let i = 0; i < 4; i++) await registry.recordOutcome(id, 'PAYIN', i === 3 ? 'FAILURE' : 'SUCCESS', 100 + i);
    const detail = await ctx.http().get(`/v1/providers/${id}`).set(bearer(opsToken));
    expect(detail.body.data.health.payin).toMatchObject({ requests: 4, success_rate: 0.75 });
  });

  it('is platform-only', async () => {
    const owner = (await signIn(ctx, 'owner@sharma-electronics.local')).accessToken!;
    expect((await ctx.http().get('/v1/providers').set(bearer(owner))).status).toBe(403);
    expect((await ctx.http().post('/v1/routing/simulate').set(bearer(owner)).send({ service: 'PAYOUT', merchant_id: sharmaId, amount: '1.00', method: 'IMPS' })).status).toBe(403);
  });
});

describe('inbound provider webhooks', () => {
  async function secretFor(code: string) {
    const registry = ctx.app.get(ProviderRegistryService);
    const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code } });
    return (await registry.context(p)).credentials.webhook_secret!;
  }

  it('accepts signed events once, rejects forgeries without storing them', async () => {
    const secret = await secretFor('mock-upi');
    const body = JSON.stringify({ event_id: `ev_${Date.now()}`, type: 'payment.status', data: { reference: 'pay_x', provider_order_id: 'mockord_100_pay_x', status: 'SUCCESS', amount_minor: '100' } });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const send = (signature: string, payload = body) => ctx.http().post('/v1/webhooks/providers/mock-upi').set('Content-Type', 'application/json').set('X-Mock-Signature', signature).send(payload);

    const first = await send(sig);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ received: true, duplicate: false });
    expect((await send(sig)).body.data.duplicate).toBe(true);

    const before = await ctx.prisma.providerWebhookEvent.count();
    const forged = await send(sig, body.replace('"100"', '"999999"'));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await ctx.prisma.providerWebhookEvent.count()).toBe(before);

    const stored = await ctx.prisma.providerWebhookEvent.findFirstOrThrow({ where: { provider: { code: 'mock-upi' } }, orderBy: { receivedAt: 'desc' } });
    // Processed inline; no such payment exists, so it is recorded and ignored (reconciliation flags it).
    expect(stored).toMatchObject({ eventType: 'payment.status', signatureValid: true, status: 'IGNORED' });
  });

  it('returns 404 for unknown providers', async () => {
    expect((await ctx.http().post('/v1/webhooks/providers/does-not-exist').send({})).status).toBe(404);
  });
});
