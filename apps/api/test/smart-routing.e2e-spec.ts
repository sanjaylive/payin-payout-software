import { randomUUID } from 'node:crypto';
import { newId } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingService } from '../src/modules/providers/routing.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

/**
 * The routing policy is global and suites share the database, so SCORE decisions are exercised by
 * stubbing this app instance's policy; the stored policy is only ever written with PRIORITY.
 */
let ctx: TestContext;
let ops: string;
let merchant: { id: string; owner: string };
let upi1: string;
let upi2: string;
const routeIds: string[] = [];

/** Inert outcome rows on CARD (no other suite uses it): no success_at, so settlement and invoicing skip them. */
async function outcomes(providerId: string, success: number, failed: number) {
  const base = { merchantId: merchant.id, method: 'CARD' as const, amountMinor: 10_000n, netAmountMinor: 10_000n, providerId, expiresAt: new Date(Date.now() + 600_000) };
  await ctx.prisma.payment.createMany({
    data: [
      ...Array.from({ length: success }, () => ({ ...base, id: newId('payment'), merchantOrderId: `sr_${randomUUID().slice(0, 12)}`, status: 'SUCCESS' as const, captureJournalId: `jrn_test_${randomUUID().slice(0, 8)}` })),
      ...Array.from({ length: failed }, () => ({ ...base, id: newId('payment'), merchantOrderId: `sr_${randomUUID().slice(0, 12)}`, status: 'FAILED' as const, failureCode: 'DECLINED' })),
    ],
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: (await orgBySlug(ctx, 'pay2all')).id })).email)).accessToken;
  merchant = await createApprovedMerchant(ctx);
  upi1 = (await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-upi' } })).id;
  upi2 = (await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-upi-2' } })).id;
  // Two peers for this merchant only: mock-upi PRIMARY, mock-upi-2 SECONDARY.
  for (const [providerId, tier] of [[upi1, 'PRIMARY'], [upi2, 'SECONDARY']] as const) {
    const r = await ctx.http().post('/v1/provider-routes').set(bearer(ops)).send({ name: `smart ${tier} ${merchant.id.slice(-5)}`, service: 'PAYIN', tier, priority: 1, provider_id: providerId, merchant_id: merchant.id, risk_categories: [], is_active: true });
    expect(r.status).toBe(201);
    routeIds.push(r.body.data.id);
  }
  await outcomes(upi1, 10, 30);
  await outcomes(upi2, 30, 2);
});

afterAll(async () => {
  await ctx.prisma.payment.deleteMany({ where: { merchantId: merchant.id, method: 'CARD' } });
  await ctx.prisma.providerRoute.updateMany({ where: { id: { in: routeIds } }, data: { isActive: false } });
  await ctx.app.close();
});

const simulate = () => ctx.http().post('/v1/routing/simulate').set(bearer(ops)).send({ service: 'PAYIN', merchant_id: merchant.id, amount: '100.00', method: 'UPI_QR' });

describe('smart routing', () => {
  it('scores providers from recent outcomes, smoothed towards the pooled rate', async () => {
    const res = await ctx.http().get('/v1/routing/scores').query({ service: 'PAYIN', method: 'CARD' }).set(bearer(ops));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.prior).toBeCloseTo(40 / 72, 4);
    type Row = { code: string; smoothed: number; score: number };
    const by = (code: string) => d.providers.find((r: Row) => r.code === code) as Row;
    const [first, second] = [by('mock-upi-2'), by('mock-upi')];
    expect(d.providers[0].code).toBe('mock-upi-2');
    // A gateway with no completed transactions sits at the prior: between the two.
    expect(d.providers.filter((r: Row & { completed: number }) => r.completed === 0).every((r: Row) => r.smoothed === d.prior)).toBe(true);
    expect(first).toMatchObject({ code: 'mock-upi-2', completed: 32, success: 30, conversion: 0.9375 });
    expect(first.smoothed).toBeCloseTo((30 + 20 * (40 / 72)) / 52, 4);
    expect(second).toMatchObject({ code: 'mock-upi', completed: 40, success: 10, conversion: 0.25 });
    expect(second.smoothed).toBeCloseTo((10 + 20 * (40 / 72)) / 60, 4);
    // Merchants never see gateway scores.
    expect((await ctx.http().get('/v1/routing/scores').query({ service: 'PAYIN', method: 'CARD' }).set(bearer(merchant.owner))).status).toBe(403);
  });

  it('PRIORITY follows tiers; SCORE puts the better-converting peer first, and payments follow it', async () => {
    expect((await simulate()).body.data).toMatchObject({ strategy: 'PRIORITY', candidates: [expect.objectContaining({ provider_code: 'mock-upi', score: null }), expect.objectContaining({ provider_code: 'mock-upi-2' })] });

    const svc = ctx.app.get(RoutingService);
    const original = { policy: svc.policy.bind(svc), conversion: svc.conversion.bind(svc), random: svc.random };
    svc.policy = () => Promise.resolve({ strategy: 'SCORE', windowMinutes: 60, minSamples: 20, explorePercent: 5, version: 1, updatedAt: null });
    svc.conversion = (service, _method, policy) => original.conversion(service, 'CARD', policy);
    svc.random = () => 0.99;
    try {
      const d = (await simulate()).body.data;
      expect(d.strategy).toBe('SCORE');
      expect(d.candidates.slice(0, 2).map((c: { provider_code: string }) => c.provider_code)).toEqual(['mock-upi-2', 'mock-upi']);
      expect(d.candidates[0].score).toBeGreaterThan(d.candidates[1].score);

      const pay = await ctx.http().post('/v1/payments').set(bearer(merchant.owner)).set('Idempotency-Key', `k_${randomUUID().replace(/-/g, '')}`).send({ merchant_order_id: `sr_${randomUUID().slice(0, 12)}`, amount: '100.00', currency: 'INR', method: 'UPI', customer: { name: 'Asha', mobile: '9876500011', vpa: 'asha@okbank' } });
      expect(pay.status).toBe(201);
      expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.payment_id } })).providerId).toBe(upi2);

      // Exploration sends a small share to the runner-up.
      svc.random = () => 0.01;
      expect((await simulate()).body.data.candidates[0]).toMatchObject({ provider_code: 'mock-upi', explored: true });
    } finally {
      Object.assign(svc, original);
    }
  });

  it('policy changes are validated, need routing.manage, and are audited', async () => {
    const before = (await ctx.http().get('/v1/routing/policies').set(bearer(ops))).body.data;
    expect(before.map((p: { service: string }) => p.service)).toEqual(['PAYIN', 'PAYOUT']);
    expect((await ctx.http().put('/v1/routing/policies/PAYOUT').set(bearer(ops)).send({ strategy: 'PRIORITY', explore_percent: 50, reason: 'too much exploring' })).status).toBe(400);
    expect((await ctx.http().put('/v1/routing/policies/PAYOUT').set(bearer(merchant.owner)).send({ strategy: 'PRIORITY', reason: 'not allowed here' })).status).toBe(403);
    const saved = await ctx.http().put('/v1/routing/policies/PAYOUT').set(bearer(ops)).send({ strategy: 'PRIORITY', window_minutes: 90, min_samples: 30, explore_percent: 3, reason: 'Tune the payout window' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ service: 'PAYOUT', strategy: 'PRIORITY', window_minutes: 90, min_samples: 30, explore_percent: 3 });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'routing.policy.updated', resourceId: 'PAYOUT' } })).toBeGreaterThan(0);
  });
});
