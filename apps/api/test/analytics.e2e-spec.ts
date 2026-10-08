import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let merchant: { id: string; owner: string };
let other: { id: string; owner: string };
let ops: string;
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const range = () => ({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

async function webhook(paymentId: string, data: Record<string, unknown>) {
  const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
  const secret = (await ctx.app.get(ProviderRegistryService).context(provider)).credentials.webhook_secret!;
  const body = JSON.stringify({ event_id: `ev_${randomUUID()}`, type: 'payment.status', data: { reference: p.id, provider_order_id: p.providerOrderId, ...data } });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  await ctx.http().post(`/v1/webhooks/providers/${provider.code}`).set('Content-Type', 'application/json').set('X-Mock-Signature', sig).send(body).expect(200);
}

async function payment(token: string, amount: string, outcome: 'SUCCESS' | 'FAILED' | 'PENDING') {
  const res = await ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key()).send({ merchant_order_id: `an_${randomUUID().slice(0, 12)}`, amount, currency: 'INR', method: 'UPI', customer: { name: 'Asha', mobile: '9876500011', vpa: 'asha@okbank' } });
  expect(res.status).toBe(201);
  const id = res.body.data.payment_id as string;
  if (outcome === 'SUCCESS') await webhook(id, { status: 'SUCCESS', amount_minor: String(Math.round(Number(amount) * 100)), utr: '412345678901', rrn: '612345678901', payer_vpa: 'asha@okbank' });
  if (outcome === 'FAILED') await webhook(id, { status: 'FAILED', failure_reason: 'Payer declined' });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  merchant = await createApprovedMerchant(ctx);
  other = await createApprovedMerchant(ctx);
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: (await orgBySlug(ctx, 'pay2all')).id })).email)).accessToken;
  await payment(merchant.owner, '100.00', 'SUCCESS');
  await payment(merchant.owner, '300.00', 'SUCCESS');
  await payment(merchant.owner, '50.00', 'FAILED');
  await payment(merchant.owner, '20.00', 'PENDING');
  await payment(other.owner, '999.00', 'SUCCESS');
});

afterAll(async () => {
  await ctx.app.close();
});

describe('analytics', () => {
  it('merchant: success rate excludes in-flight payments, with methods, failure reasons and peak hour — no gateways', async () => {
    const res = await ctx.http().get('/v1/analytics').query({ kind: 'payin', ...range() }).set(bearer(merchant.owner));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toMatchObject({ count: 4, success_count: 2, failed_count: 1, success_rate: 0.6667, success_amount: '400.00', avg_ticket: '200.00' });
    expect(d.live).toMatchObject({ window_minutes: 15, count: 4, success_count: 2 });
    expect(d.by_method).toEqual([expect.objectContaining({ method: 'UPI_QR', count: 4, success_count: 2 })]);
    expect(d.failure_reasons).toEqual([expect.objectContaining({ count: 1, share: 1 })]);
    expect(d.hours).toHaveLength(24);
    expect(d.hours.reduce((s: number, h: { count: number }) => s + h.count, 0)).toBe(4);
    expect(d.peak_hour).toBe(d.hours.find((h: { count: number }) => h.count === 4).hour);
    expect(d.by_gateway).toBeNull();
  });

  it('platform: sees gateways and can filter to a merchant; merchants cannot see other merchants', async () => {
    const all = (await ctx.http().get('/v1/analytics').query({ kind: 'payin', ...range() }).set(bearer(ops))).body.data;
    expect(all.by_gateway.length).toBeGreaterThan(0);
    expect(all.by_gateway[0]).toEqual(expect.objectContaining({ code: expect.any(String), name: expect.any(String), success_rate: expect.any(Number) }));
    const one = (await ctx.http().get('/v1/analytics').query({ kind: 'payin', merchant_id: other.id, ...range() }).set(bearer(ops))).body.data;
    expect(one.totals).toMatchObject({ count: 1, success_count: 1, success_amount: '999.00' });
    expect((await ctx.http().get('/v1/analytics').query({ kind: 'payin', merchant_id: other.id, ...range() }).set(bearer(merchant.owner))).status).toBe(404);
  });

  it('payouts use the same shape; bad ranges are refused', async () => {
    const p = await ctx.http().get('/v1/analytics').query({ kind: 'payout', ...range() }).set(bearer(merchant.owner));
    expect(p.body.data.totals).toMatchObject({ count: 0, success_rate: null });
    expect((await ctx.http().get('/v1/analytics').query({ kind: 'payin', from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }).set(bearer(merchant.owner))).status).toBe(400);
    expect((await ctx.http().get('/v1/analytics').query({ kind: 'payin', from: range().to, to: range().from }).set(bearer(merchant.owner))).status).toBe(400);
  });
});
