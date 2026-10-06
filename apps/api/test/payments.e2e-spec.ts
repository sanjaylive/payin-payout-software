import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Accounts } from '@pay2all/ledger/engine';
import { PayinJobsService } from '../src/modules/payments/payin-jobs.service';
import { RefundsService } from '../src/modules/payments/refunds.service';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let sharmaId: string;
let kiranaId: string;
let owner: string; // Sharma merchant owner
let kiranaOwner: string;
let ops: string; // platform operations (risk.review, internal views)
let admin: string; // platform admin (pricing.manage)

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const orderId = (p = 'ord') => `${p}_${randomUUID().slice(0, 12)}`;

function createPayment(token: string, body: Record<string, unknown>, idem = key()) {
  return ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', idem).send(body);
}
const pay = (amount: string, extra: Record<string, unknown> = {}) => ({ merchant_order_id: orderId(), amount, currency: 'INR', method: 'UPI', customer: { name: 'Asha', mobile: '9876500011', vpa: 'asha@okbank' }, ...extra });

async function webhook(code: string, data: Record<string, unknown>, type = 'payment.status') {
  const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code } });
  const secret = (await ctx.app.get(ProviderRegistryService).context(p)).credentials.webhook_secret!;
  const body = JSON.stringify({ event_id: `ev_${randomUUID()}`, type, data });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return { body, sig, send: () => ctx.http().post(`/v1/webhooks/providers/${code}`).set('Content-Type', 'application/json').set('X-Mock-Signature', sig).send(body) };
}
async function paySuccess(paymentId: string, extra: Record<string, unknown> = {}) {
  const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
  return (await webhook(provider.code, { reference: p.id, provider_order_id: p.providerOrderId, status: 'SUCCESS', amount_minor: p.amountMinor.toString(), utr: '412345678901', rrn: '612345678901', payer_vpa: 'asha@okbank', ...extra })).send();
}
const balance = async (code: string) => (await ctx.prisma.ledgerAccount.findUnique({ where: { code } }))?.balanceMinor ?? 0n;

/** Create + capture a payment; returns its id. */
async function capturedPayment(amount: string) {
  const res = await createPayment(owner, pay(amount));
  expect(res.status).toBe(201);
  expect((await paySuccess(res.body.data.payment_id)).status).toBe(200);
  return res.body.data.payment_id as string;
}

beforeAll(async () => {
  ctx = await createTestContext();
  sharmaId = (await orgBySlug(ctx, 'sharma-electronics')).id;
  kiranaId = (await orgBySlug(ctx, 'kirana-fresh')).id;
  owner = (await login(ctx, 'owner@sharma-electronics.local')).accessToken!;
  kiranaOwner = (await login(ctx, 'owner@kirana-fresh.local')).accessToken!;
  const platform = await orgBySlug(ctx, 'pay2all');
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  // Make sandbox outcomes immediate for polling tests.
  for (const code of ['mock-upi', 'mock-upi-2']) {
    const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code } });
    await ctx.prisma.provider.update({ where: { id: p.id }, data: { config: { ...(p.config as object), auto_success_after_ms: 0 } } });
  }
});

afterAll(async () => {
  await ctx.app.close();
});

describe('create payment', () => {
  it('creates a PENDING UPI payment with QR, snapshotting fees exactly (₹1000 → 1.80 + 0.32 GST)', async () => {
    const res = await createPayment(owner, pay('1000.00', { description: 'Order 1' }));
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({ status: 'PENDING', amount: '1000.00', fee: '1.80', tax: '0.32', net_amount: '997.88', method: 'UPI_QR', currency: 'INR' });
    expect(d.qr).toMatch(/^upi:\/\/pay\?/);
    expect(d.provider).toBeUndefined(); // routing details are internal

    const snap = await ctx.prisma.transactionPricingSnapshot.findUniqueOrThrow({ where: { transactionId: d.payment_id } });
    expect(snap).toMatchObject({ merchantFeeMinor: 180n, taxMinor: 32n, wholesaleFeeMinor: 140n, providerCostMinor: 100n, resellerMarginMinor: 40n, platformMarginMinor: 40n });
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: d.payment_id } })).toBe(2); // created + pending
  });

  it('rejects JSON-number amounts and requires an Idempotency-Key', async () => {
    const numeric = await createPayment(owner, pay('1.00', { amount: 1000 }));
    expect(numeric.status).toBe(400);
    const noKey = await ctx.http().post('/v1/payments').set(bearer(owner)).send(pay('10.00'));
    expect(noKey.status).toBe(400);
  });

  it('replays the stored response for the same key, and conflicts on a different body', async () => {
    const idem = key();
    const body = pay('250.00');
    const first = await createPayment(owner, body, idem);
    const again = await createPayment(owner, body, idem);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.payment_id).toBe(first.body.data.payment_id);
    const conflict = await createPayment(owner, { ...body, amount: '251.00' }, idem);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await ctx.prisma.payment.count({ where: { merchantOrderId: body.merchant_order_id } })).toBe(1);
  });

  it('creates exactly one payment for concurrent requests with the same key', async () => {
    const idem = key();
    const body = pay('42.00');
    const results = await Promise.all(Array.from({ length: 5 }, () => createPayment(owner, body, idem)));
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await ctx.prisma.payment.count({ where: { merchantOrderId: body.merchant_order_id } })).toBe(1);
  });

  it('rejects a reused merchant_order_id with a new key', async () => {
    const body = pay('11.00');
    expect((await createPayment(owner, body)).status).toBe(201);
    const dup = await createPayment(owner, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_ORDER');
  });

  it('enforces merchant state: KYC, payin switch, suspension', async () => {
    const r1 = await createPayment(kiranaOwner, pay('10.00'));
    expect(r1.body.error.code).toBe('KYC_NOT_APPROVED');
    await ctx.prisma.merchant.update({ where: { id: kiranaId }, data: { status: 'APPROVED', payinEnabled: false } });
    expect((await createPayment(kiranaOwner, pay('10.00'))).body.error.code).toBe('PAYIN_DISABLED');
    await ctx.prisma.merchant.update({ where: { id: kiranaId }, data: { status: 'SUSPENDED' } });
    expect((await createPayment(kiranaOwner, pay('10.00'))).body.error.code).toBe('MERCHANT_INACTIVE');
    await ctx.prisma.merchant.update({ where: { id: kiranaId }, data: { status: 'APPROVED', payinEnabled: true } });
    expect((await createPayment(kiranaOwner, pay('10.00'))).status).toBe(201);
  });

  it('enforces per-transaction limits', async () => {
    const big = await createPayment(owner, pay('99999999.00'));
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('fails over to the fallback provider when the primary definitively rejects (.91)', async () => {
    const res = await createPayment(owner, pay('300.91'));
    expect(res.body.data.status).toBe('PENDING');
    const detail = await ctx.http().get(`/v1/payments/${res.body.data.payment_id}`).set(bearer(ops));
    expect(detail.body.data.provider).toBe('mock-upi-2');
    expect(detail.body.data.attempts.map((a: { provider: string; status: string }) => `${a.provider}:${a.status}`)).toEqual(['mock-upi:FAILED', 'mock-upi-2:SUCCEEDED']);
  });

  it('never fails over on an ambiguous create (.92): stays CREATED, one attempt, no QR', async () => {
    const res = await createPayment(owner, pay('300.92'));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'CREATED', qr: null });
    expect(await ctx.prisma.paymentAttempt.count({ where: { paymentId: res.body.data.payment_id } })).toBe(1);
  });
});

describe('capture via callbacks', () => {
  it('posts the capture journal once; duplicate callbacks are no-ops', async () => {
    const providerCode = 'mock-upi';
    const unsettledBefore = await balance(Accounts.merchant(sharmaId, 'UNSETTLED'));
    const res = await createPayment(owner, pay('1000.00'));
    const id = res.body.data.payment_id as string;
    expect((await paySuccess(id)).body.data).toEqual({ received: true, duplicate: false });
    expect((await paySuccess(id)).status).toBe(200); // different event id, same outcome

    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: 'SUCCESS', utr: '412345678901' });
    const journals = await ctx.prisma.ledgerJournal.findMany({ where: { sourceType: 'PAYMENT', sourceId: id } });
    expect(journals).toHaveLength(1);
    expect(await balance(Accounts.merchant(sharmaId, 'UNSETTLED'))).toBe(unsettledBefore + 99_788n);
    // Platform accounts have no maintained balance (hot-account design) — assert the entries instead.
    const entries = await ctx.prisma.ledgerEntry.findMany({ where: { journalId: journals[0]!.id }, include: { account: { select: { code: true } } } });
    expect(Object.fromEntries(entries.map((e) => [e.account.code, `${e.direction}:${e.amountMinor}`]))).toEqual({
      [Accounts.providerClearing(providerCode)]: 'DEBIT:100000',
      [Accounts.merchant(sharmaId, 'UNSETTLED')]: 'CREDIT:99788',
      [Accounts.FEE_REVENUE]: 'CREDIT:180',
      [Accounts.GST_PAYABLE]: 'CREDIT:32',
    });
    const events = await ctx.prisma.webhookEvent.findMany({ where: { resourceId: id, type: 'payment.success' } });
    expect(events).toHaveLength(1);
  });

  it('holds an amount mismatch for review without capturing', async () => {
    const id = (await createPayment(owner, pay('500.00'))).body.data.payment_id as string;
    await paySuccess(id, { amount_minor: '5000' });
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: 'PENDING', requiresReview: true, captureJournalId: null });
    const internal = await ctx.http().get(`/v1/payments/${id}`).set(bearer(ops));
    expect(internal.body.data.review_reason).toContain('₹50.00');
    // Mismatches are not accepted through the late-success review path.
    expect((await ctx.http().post(`/v1/payments/${id}/review/accept`).set(bearer(ops)).send({ reason: 'looks fine to me' })).status).toBe(400);
  });

  it('auto-accepts a late success after failure (default policy) and flags it', async () => {
    const id = (await createPayment(owner, pay('20.00'))).body.data.payment_id as string;
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    await (await webhook('mock-upi', { reference: id, provider_order_id: p.providerOrderId, status: 'FAILED', failure_reason: 'declined' })).send();
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
    await paySuccess(id);
    const after = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: 'SUCCESS', lateSuccess: true });
    expect(after.captureJournalId).not.toBeNull();
  });

  it('holds a late success for MANUAL_REVIEW merchants until a reviewer accepts it', async () => {
    await ctx.prisma.merchant.update({ where: { id: kiranaId }, data: { lateSuccessPolicy: 'MANUAL_REVIEW', status: 'APPROVED', payinEnabled: true } });
    const id = (await createPayment(kiranaOwner, pay('30.00'))).body.data.payment_id as string;
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    await (await webhook('mock-upi', { reference: id, provider_order_id: p.providerOrderId, status: 'EXPIRED' })).send();
    await paySuccess(id);
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'EXPIRED', requiresReview: true, captureJournalId: null });
    // Merchants can't accept their own late successes.
    expect((await ctx.http().post(`/v1/payments/${id}/review/accept`).set(bearer(kiranaOwner)).send({ reason: 'please accept' })).status).toBe(403);
    const accepted = await ctx.http().post(`/v1/payments/${id}/review/accept`).set(bearer(ops)).send({ reason: 'UTR verified with bank statement' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: 'SUCCESS', late_success: true, requires_review: false });
  });
});

describe('tenancy and reads', () => {
  it('hides other merchants’ payments (404) and masks payer data in lists', async () => {
    const id = (await createPayment(owner, pay('15.00'))).body.data.payment_id as string;
    expect((await ctx.http().get(`/v1/payments/${id}`).set(bearer(kiranaOwner))).status).toBe(404);
    const list = await ctx.http().get('/v1/payments').query({ payment_id: id }).set(bearer(kiranaOwner));
    expect(list.body.data).toHaveLength(0);
    const own = await ctx.http().get('/v1/payments').query({ payment_id: id }).set(bearer(owner));
    expect(own.body.data[0].customer.mobile).toBe('+91******0011');
    expect(own.body.data[0].qr).toBeUndefined();
    expect((await ctx.http().post(`/v1/payments/${id}/refunds`).set(bearer(kiranaOwner)).set('Idempotency-Key', key()).send({ amount: '1.00' })).status).toBe(404);
  });

  it('reports stats in IST buckets', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const res = await ctx.http().get('/v1/payments/stats').query({ from, to, bucket: 'day' }).set(bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.success_count).toBeGreaterThan(0);
  });
});

describe('refunds', () => {
  const refund = (paymentId: string, amount: string, extra: Record<string, unknown> = {}, idem = key()) =>
    ctx.http().post(`/v1/payments/${paymentId}/refunds`).set(bearer(owner)).set('Idempotency-Key', idem).send({ amount, ...extra });

  it('refunds partially, then the rest; rejects over-refunds', async () => {
    await capturedPayment('2000.00'); // headroom so the full refund can cover the fee shortfall
    const id = await capturedPayment('100.00');
    const r1 = await refund(id, '40.00', { merchant_refund_id: orderId('rf') });
    expect(r1.status).toBe(201);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('REFUND_PENDING');
    const over = await refund(id, '60.01');
    expect(over.body.error.code).toBe('REFUND_NOT_ALLOWED');
    expect((await refund(id, '60.00')).status).toBe(201);

    const jobs = ctx.app.get(RefundsService);
    await ctx.prisma.refund.updateMany({ where: { paymentId: id }, data: { nextAttemptAt: new Date(0) } });
    await jobs.processDue();
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: 'REFUNDED', refundedAmountMinor: 10_000n });
    expect((await refund(id, '0.01')).body.error.code).toBe('REFUND_NOT_ALLOWED');
  });

  it('never lets concurrent refunds exceed the payment', async () => {
    const id = await capturedPayment('50.00');
    const results = await Promise.all(Array.from({ length: 6 }, () => refund(id, '20.00')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const total = await ctx.prisma.refund.aggregate({ where: { paymentId: id }, _sum: { amountMinor: true } });
    expect(total._sum.amountMinor).toBe(4_000n);
  });

  it('reverses the ledger exactly when the provider fails the refund (.13)', async () => {
    const id = await capturedPayment('80.00');
    const unsettled = Accounts.merchant(sharmaId, 'UNSETTLED');
    const before = await balance(unsettled);
    const r = await refund(id, '10.13');
    expect(r.status).toBe(201);
    expect(await balance(unsettled)).toBe(before - 1_013n);
    await ctx.prisma.refund.update({ where: { id: r.body.data.refund_id }, data: { nextAttemptAt: new Date(0) } });
    await ctx.app.get(RefundsService).processDue();
    const done = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: r.body.data.refund_id } });
    expect(done.status).toBe('FAILED');
    expect(done.reversalJournalId).not.toBeNull();
    expect(await balance(unsettled)).toBe(before);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCESS');
  });

  it('refuses refunds of uncaptured payments', async () => {
    const id = (await createPayment(owner, pay('12.00'))).body.data.payment_id as string;
    expect((await refund(id, '1.00')).body.error.code).toBe('REFUND_NOT_ALLOWED');
  });
});

describe('background jobs and sandbox', () => {
  it('polls open payments to completion', async () => {
    const id = (await createPayment(owner, pay('60.00'))).body.data.payment_id as string;
    await ctx.prisma.payment.update({ where: { id }, data: { nextPollAt: new Date(0) } });
    await ctx.app.get(PayinJobsService).pollOpenPayments();
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCESS');
  });

  it('expires stale payments after a final status check', async () => {
    const pending = (await createPayment(owner, pay('61.50'))).body.data.payment_id as string; // .50 stays PENDING
    const ambiguous = (await createPayment(owner, pay('61.92'))).body.data.payment_id as string; // never confirmed
    const past = new Date(Date.now() - 3_600_000);
    await ctx.prisma.payment.updateMany({ where: { id: { in: [pending, ambiguous] } }, data: { expiresAt: past } });
    await ctx.app.get(PayinJobsService).expireStalePayments();
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pending } })).status).toBe('EXPIRED');
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: ambiguous } })).status).toBe('EXPIRED');
  });

  it('sandbox simulator completes a payment through the signed callback path', async () => {
    const id = (await createPayment(owner, pay('75.00'))).body.data.payment_id as string;
    const res = await ctx.http().post(`/v1/sandbox/payments/${id}/complete`).set(bearer(owner)).send({ outcome: 'SUCCESS' });
    expect(res.status).toBe(200);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCESS');
    expect(await ctx.prisma.providerWebhookEvent.count({ where: { status: 'PROCESSED', payload: { path: ['reference'], equals: id } } })).toBe(1);
  });
});

describe('pricing', () => {
  it('keeps historical snapshots unchanged after a plan change', async () => {
    const id = (await createPayment(owner, pay('1000.00'))).body.data.payment_id as string;
    const plan = await ctx.http().post('/v1/pricing/plans').set(bearer(admin)).send({ name: 'Promo', kind: 'MERCHANT', is_default: true, rules: [{ service: 'PAYIN', charge_type: 'PERCENTAGE', rate: '0.50' }] });
    expect(plan.status).toBe(201);
    const after = await createPayment(owner, pay('1000.00'));
    expect(after.body.data.fee).toBe('5.00');
    const old = await ctx.prisma.transactionPricingSnapshot.findUniqueOrThrow({ where: { transactionId: id } });
    expect(old.merchantFeeMinor).toBe(180n);
    await expect(ctx.prisma.transactionPricingSnapshot.update({ where: { transactionId: id }, data: { merchantFeeMinor: 1n } })).rejects.toThrow();
    // Restore the standard plan for other suites.
    await ctx.http().post(`/v1/pricing/plans/${plan.body.data.id}/archive`).set(bearer(admin));
    const std = await ctx.prisma.pricingPlan.findFirstOrThrow({ where: { kind: 'MERCHANT', name: 'Standard merchant pricing' } });
    await ctx.prisma.pricingPlan.update({ where: { id: std.id }, data: { isDefault: true } });
  });
});
