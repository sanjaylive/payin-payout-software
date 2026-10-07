import { randomUUID } from 'node:crypto';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PayoutProcessorService } from '../src/modules/payouts/payout-processor.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let admin: string;
const reason = 'Scheme e2e test';
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const orderId = () => `sch_${randomUUID().slice(0, 12)}`;
let acct = 0;
const accountNo = () => `5010${String(Date.now()).slice(-7)}${String(++acct).padStart(3, '0')}1`;

const balance = async (code: string) => (await ctx.prisma.ledgerAccount.findUnique({ where: { code } }))?.balanceMinor ?? 0n;
const lines = async (journalId: string) =>
  Object.fromEntries((await ctx.prisma.ledgerEntry.findMany({ where: { journalId }, include: { account: { select: { code: true } } } })).map((e) => [e.account.code, `${e.direction}:${e.amountMinor}`]));

async function fund(merchantId: string, minor: bigint) {
  const ledger = ctx.app.get(LedgerService);
  await ledger.run((tx) =>
    ledger.post(tx, {
      type: 'ADJUSTMENT_CREDIT',
      idempotencyKey: `test-fund:${randomUUID()}`,
      source: { type: 'ADJUSTMENT', id: `adj_${randomUUID()}` },
      description: 'Test funding',
      lines: [
        { accountCode: Accounts.ADJUSTMENT_SUSPENSE, direction: 'DEBIT', amountMinor: minor, currency: 'INR' },
        { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: minor, currency: 'INR' },
      ],
    }),
  );
}

async function cleanup() {
  await ctx.prisma.merchant.updateMany({ where: { schemeId: { not: null } }, data: { schemeId: null } });
  await ctx.prisma.schemeRate.deleteMany({});
  await ctx.prisma.scheme.deleteMany({});
  await ctx.prisma.pricingProvider.deleteMany({ where: { id: { gt: 3 } } });
}

const gold = (extra: Record<string, unknown> = {}) => ({
  name: `Gold ${randomUUID().slice(0, 6)}`,
  description: 'Commission on large collections',
  tax_rate: '18',
  rates: [
    // Dynamic QR: ₹2 charge up to ₹1,000; 0.5 % commission above.
    { provider_id: 2, min_amount: '0.00', max_amount: '1000.00', type: 'FLAT', value: '-2' },
    { provider_id: 2, min_amount: '1000.01', max_amount: null, type: 'PERCENT', value: '0.5' },
    // Payout: ₹3 commission on any amount.
    { provider_id: 1, min_amount: '1.00', max_amount: null, type: 'FLAT', value: '3' },
  ],
  reason,
  ...extra,
});

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  await cleanup();
  const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-payout' } });
  await ctx.prisma.provider.update({ where: { id: p.id }, data: { config: { ...(p.config as object), auto_success_after_ms: 0 } } });
});

afterAll(async () => {
  await cleanup();
  const unbalanced = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (
      SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END)) j`;
  expect(unbalanced[0]!.n).toBe(0n);
  await ctx.app.close();
});

describe('pricing providers', () => {
  it('ships 1 = Payout, 2 = Dynamic QR, 3 = Static QR; only super admins change them', async () => {
    const list = await ctx.http().get('/v1/pricing-providers').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.slice(0, 3).map((p: { id: number; name: string; service: string }) => [p.id, p.name, p.service])).toEqual([
      [1, 'Payout', 'PAYOUT'],
      [2, 'Dynamic QR', 'PAYIN'],
      [3, 'Static QR', 'PAYIN'],
    ]);
    const body = { name: 'Virtual Account', service: 'PAYIN', methods: ['VIRTUAL_ACCOUNT'], description: 'Bank transfers to a VA', reason };
    expect((await ctx.http().post('/v1/pricing-providers').set(bearer(admin)).send(body)).status).toBe(403);
    const created = await ctx.http().post('/v1/pricing-providers').set(bearer(superAdmin)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.id).toBeGreaterThanOrEqual(4);

    // A method is priced by one provider only; a payout mode can't go on a payin provider.
    const clash = await ctx.http().post('/v1/pricing-providers').set(bearer(superAdmin)).send({ ...body, name: 'QR again', methods: ['UPI_QR'] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/UPI_QR \(provider 2, Dynamic QR\)/);
    expect((await ctx.http().post('/v1/pricing-providers').set(bearer(superAdmin)).send({ ...body, name: 'Wrong', methods: ['IMPS'] })).status).toBe(400);
    expect((await ctx.http().post('/v1/pricing-providers').set(bearer(superAdmin)).send({ ...body, methods: ['NETBANKING'] })).status).toBe(409); // duplicate name

    expect((await ctx.http().post(`/v1/pricing-providers/${created.body.data.id}/remove`).set(bearer(superAdmin)).send({ reason })).status).toBe(200);
  });

  it('merchants cannot see platform pricing', async () => {
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/schemes').set(bearer(m.owner))).status).toBe(403);
    expect((await ctx.http().get('/v1/pricing-providers').set(bearer(m.owner))).status).toBe(403);
  });
});

describe('schemes', () => {
  it('rejects overlapping slabs, JSON numbers and unknown providers', async () => {
    const overlap = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold({ rates: [...gold().rates, { provider_id: 2, min_amount: '500.00', max_amount: '600.00', type: 'FLAT', value: '-1' }] }));
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.message).toMatch(/Dynamic QR: slabs .* overlap/);
    expect((await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold({ rates: [{ provider_id: 2, min_amount: '0.00', max_amount: null, type: 'FLAT', value: -2 }] }))).status).toBe(400);
    expect((await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold({ rates: [{ provider_id: 999, min_amount: '0.00', max_amount: null, type: 'FLAT', value: '-2' }] }))).status).toBe(400);
    expect((await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold({ rates: [{ provider_id: 2, min_amount: '0.00', max_amount: null, type: 'PERCENT', value: '-101' }] }))).status).toBe(400);
  });

  it('charges, credits commission, claws it back on refund — and the ledger balances', async () => {
    const created = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold());
    expect(created.status).toBe(201);
    expect(created.body.data.rates.map((r: { value: string; kind: string }) => `${r.value}:${r.kind}`)).toEqual(['3.00:COMMISSION', '-2.00:CHARGE', '0.5:COMMISSION']);
    const schemeId = created.body.data.id as string;

    const m = await createApprovedMerchant(ctx);
    const assign = await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: schemeId, target: 'MERCHANTS', merchant_ids: [m.id], reason });
    expect(assign.body.data).toEqual({ updated: 1 });

    const preview = await ctx.http().post('/v1/schemes/preview').set(bearer(admin)).send({ merchant_id: m.id, method: 'UPI_QR', amount: '2000.00' });
    expect(preview.body.data).toMatchObject({ provider: { id: 2, name: 'Dynamic QR' }, fee: '0.00', commission: '10.00', merchant_net: '2010.00' });

    // Charge slab: ₹500 → ₹2 + 18 % GST.
    const small = await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: orderId(), amount: '500.00', currency: 'INR', method: 'UPI' });
    expect(small.status).toBe(201);
    expect(small.body.data).toMatchObject({ fee: '2.00', tax: '0.36', commission: '0.00' });

    // Commission slab: ₹2,000 → 0.5 % = ₹10 credited on top, no GST.
    const big = await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: orderId(), amount: '2000.00', currency: 'INR', method: 'UPI' });
    expect(big.body.data).toMatchObject({ fee: '0.00', tax: '0.00', commission: '10.00' });
    const id = big.body.data.payment_id as string;
    await ctx.http().post(`/v1/sandbox/payments/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'SUCCESS' }).expect(200);
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(p.status).toBe('SUCCESS');
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
    expect(await lines(p.captureJournalId!)).toEqual({
      [Accounts.providerClearing(provider.code)]: 'DEBIT:200000',
      [Accounts.MERCHANT_COMMISSION]: 'DEBIT:1000',
      [Accounts.merchant(m.id, 'UNSETTLED')]: 'CREDIT:201000',
    });
    const snap = await ctx.prisma.transactionPricingSnapshot.findUniqueOrThrow({ where: { transactionId: id } });
    expect(snap).toMatchObject({ merchantFeeMinor: 0n, merchantCommissionMinor: 1000n, platformMarginMinor: -1000n - snap.providerCostMinor });
    expect((snap.pricing as { scheme: { name: string; rate: { value: string } } }).scheme).toMatchObject({ name: created.body.data.name, rate: { value: '500000' } });

    // Refund half: half the commission comes back too.
    const refund = await ctx.http().post(`/v1/payments/${id}/refunds`).set(bearer(m.owner)).set('Idempotency-Key', key()).send({ amount: '1000.00' });
    expect(refund.status).toBe(201);
    const r = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refund.body.data.refund_id as string } });
    expect(r.commissionClawbackMinor).toBe(500n);
    expect(await lines(r.journalId!)).toMatchObject({ [Accounts.MERCHANT_COMMISSION]: 'CREDIT:500', [Accounts.merchant(m.id, 'UNSETTLED')]: 'DEBIT:100500' });
    expect(await balance(Accounts.merchant(m.id, 'UNSETTLED'))).toBe(201_000n - 100_500n);
  });

  it('payout commission reduces the debit; a bank return gives back exactly what was debited', async () => {
    const s = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold());
    const m = await createApprovedMerchant(ctx);
    await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: s.body.data.id, target: 'MERCHANTS', merchant_ids: [m.id], reason }).expect(200);
    await fund(m.id, 500_000n);

    const res = await ctx.http().post('/v1/payouts').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: orderId(), amount: '1000.88', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Asha Kulkarni', account_number: accountNo(), ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ fee: '0.00', tax: '0.00', commission: '3.00', total_debit: '997.88' });
    const id = res.body.data.payout_id as string;
    expect(await balance(Accounts.merchant(m.id, 'AVAILABLE'))).toBe(500_000n - 99_788n);

    await ctx.prisma.payout.updateMany({ where: { status: 'QUEUED', NOT: { id } }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
    await ctx.prisma.payout.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
    await ctx.app.get(PayoutProcessorService).processQueued();
    await ctx.http().post(`/v1/sandbox/payouts/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'SUCCESS' }).expect(200);
    const done = await ctx.prisma.payout.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('SUCCESS');
    expect(await lines(done.settleJournalId!)).toEqual({
      [Accounts.merchant(m.id, 'RESERVED')]: 'DEBIT:99788',
      [Accounts.MERCHANT_COMMISSION]: 'DEBIT:300',
      [Accounts.providerClearing('mock-payout')]: 'CREDIT:100088',
    });

    await ctx.http().post(`/v1/sandbox/payouts/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'REVERSED' }).expect(200);
    const back = await ctx.prisma.payout.findUniqueOrThrow({ where: { id } });
    expect(back.status).toBe('REVERSED');
    expect(await lines(back.reversalJournalId!)).toEqual({
      [Accounts.providerClearing('mock-payout')]: 'DEBIT:100088',
      [Accounts.merchant(m.id, 'AVAILABLE')]: 'CREDIT:99788',
      [Accounts.MERCHANT_COMMISSION]: 'CREDIT:300',
    });
    expect(await balance(Accounts.merchant(m.id, 'AVAILABLE'))).toBe(500_000n);
  });

  it('a slab the scheme does not cover is refused with a clear reason', async () => {
    const s = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold({ rates: [{ provider_id: 2, min_amount: '100.00', max_amount: '200.00', type: 'FLAT', value: '-1' }] }));
    const m = await createApprovedMerchant(ctx);
    await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: s.body.data.id, target: 'MERCHANTS', merchant_ids: [m.id], reason }).expect(200);
    const res = await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: orderId(), amount: '500.00', currency: 'INR', method: 'UPI' });
    expect(res.status).toBe(403); // PAYIN_DISABLED;
    expect(res.body.error.message).toMatch(/has no rate for Dynamic QR at ₹500.00/);
  });

  it('default scheme: unassigned merchants join it; it and assigned schemes cannot be archived', async () => {
    const s = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold());
    const schemeId = s.body.data.id as string;
    const m = await createApprovedMerchant(ctx);
    const before = await ctx.http().get(`/v1/schemes/merchants/${m.id}`).set(bearer(admin));
    expect(before.body.data.effective.source).toBe('RATE_CARD'); // platform default rate card

    await ctx.http().post('/v1/schemes/default').set(bearer(admin)).send({ scheme_id: schemeId, reason }).expect(200);
    const after = await ctx.http().get(`/v1/schemes/merchants/${m.id}`).set(bearer(admin));
    expect(after.body.data).toMatchObject({ assigned: null, effective: { source: 'DEFAULT_SCHEME', id: schemeId } });
    const pay = await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: orderId(), amount: '100.00', currency: 'INR', method: 'UPI' });
    expect(pay.body.data).toMatchObject({ fee: '2.00', tax: '0.36' });

    expect((await ctx.http().post(`/v1/schemes/${schemeId}/archive`).set(bearer(admin)).send({ reason })).status).toBe(409);
    await ctx.http().post('/v1/schemes/default').set(bearer(admin)).send({ scheme_id: null, reason }).expect(200);
    await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: schemeId, target: 'MERCHANTS', merchant_ids: [m.id], reason }).expect(200);
    expect((await ctx.http().post(`/v1/schemes/${schemeId}/archive`).set(bearer(admin)).send({ reason })).status).toBe(409);
    await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: null, target: 'MERCHANTS', merchant_ids: [m.id], reason }).expect(200);
    expect((await ctx.http().post(`/v1/schemes/${schemeId}/archive`).set(bearer(admin)).send({ reason })).status).toBe(200);
  });

  it('assign to all direct merchants (resellers’ merchants only when asked)', async () => {
    const s = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold());
    const direct = await ctx.prisma.merchant.count({ where: { resellerId: null } });
    const all = await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: s.body.data.id, target: 'ALL', reason });
    expect(all.body.data.updated).toBe(direct);
    expect(await ctx.prisma.merchant.count({ where: { resellerId: { not: null }, schemeId: s.body.data.id } })).toBe(0);
    const list = await ctx.http().get('/v1/schemes').set(bearer(admin));
    expect(list.body.data.schemes.find((x: { id: string }) => x.id === s.body.data.id).merchants).toBe(direct);
    await ctx.http().post('/v1/schemes/assign').set(bearer(admin)).send({ scheme_id: null, target: 'ALL', include_reseller_merchants: true, reason }).expect(200);
    expect(await ctx.prisma.merchant.count({ where: { schemeId: { not: null } } })).toBe(0);
  });

  it('edits replace the rates, with a version check; old transactions keep their snapshot', async () => {
    const s = await ctx.http().post('/v1/schemes').set(bearer(admin)).send(gold());
    const id = s.body.data.id as string;
    const edit = { ...gold({ name: s.body.data.name }), rates: [{ provider_id: 2, min_amount: '0.00', max_amount: null, type: 'PERCENT', value: '-0.25' }], version: 1 };
    const ok = await ctx.http().put(`/v1/schemes/${id}`).set(bearer(admin)).send(edit);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ version: 2, rates: [{ value: '-0.25', kind: 'CHARGE' }] });
    expect((await ctx.http().put(`/v1/schemes/${id}`).set(bearer(admin)).send(edit)).status).toBe(409); // stale version
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'pricing.scheme.updated', resourceId: id } });
    expect(audit?.metadata).toMatchObject({ reason });
  });
});
