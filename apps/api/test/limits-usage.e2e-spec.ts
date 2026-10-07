import { randomUUID } from 'node:crypto';
import { newId } from '@pay2all/auth';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodKeys } from '../src/modules/limits/period-usage.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PaymentTransitionsService } from '../src/modules/payments/payment-transitions.service';
import { PayoutTransitionsService } from '../src/modules/payouts/payout-transitions.service';
import { bearer, createApprovedMerchant, createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const order = () => `lu_${randomUUID().slice(0, 12)}`;
const pay = (token: string, amount: string) => ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key()).send({ merchant_order_id: order(), amount, method: 'UPI' });
const usage = async (merchantId: string, service: 'PAYIN' | 'PAYOUT') => {
  const { day, month } = periodKeys(new Date());
  const rows = await ctx.prisma.merchantPeriodUsage.findMany({ where: { merchantId, service, period: { in: [day, month] } } });
  const get = (p: string) => rows.find((r) => r.period === p) ?? { amountMinor: 0n, count: 0 };
  return { day: get(day), month: get(month) };
};
async function limit(merchantId: string, service: 'PAYIN' | 'PAYOUT', data: { dailyAmountMinor?: bigint; dailyCount?: number; monthlyAmountMinor?: bigint }) {
  await ctx.prisma.limitConfig.create({ data: { id: newId('limitConfig'), level: 'MERCHANT', subjectId: merchantId, service, ...data } });
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('daily/monthly limits from running totals', () => {
  it('enforces a daily amount limit exactly, even for 20 concurrent requests', async () => {
    const m = await createApprovedMerchant(ctx);
    await limit(m.id, 'PAYIN', { dailyAmountMinor: 100_000n }); // ₹1,000
    const results = await Promise.all(Array.from({ length: 20 }, () => pay(m.owner, '100.00')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    const rejected = results.filter((r) => r.status !== 201);
    expect(rejected.every((r) => r.body.error.code === 'LIMIT_EXCEEDED' && r.body.error.message === 'Payin daily amount limit exceeded')).toBe(true);
    expect(await ctx.prisma.payment.count({ where: { merchantId: m.id } })).toBe(10);
    const u = await usage(m.id, 'PAYIN');
    expect(u.day).toMatchObject({ amountMinor: 100_000n, count: 10 });
    expect(u.month).toMatchObject({ amountMinor: 100_000n, count: 10 });
  });

  it('enforces a daily count limit and names it', async () => {
    const m = await createApprovedMerchant(ctx);
    await limit(m.id, 'PAYIN', { dailyCount: 2 });
    expect((await pay(m.owner, '10.00')).status).toBe(201);
    expect((await pay(m.owner, '10.00')).status).toBe(201);
    const third = await pay(m.owner, '10.00');
    expect(third.body.error).toMatchObject({ code: 'LIMIT_EXCEEDED', message: 'Payin daily count limit exceeded' });
  });

  it('a failed payin frees its share; a late success counts it again', async () => {
    const m = await createApprovedMerchant(ctx);
    await limit(m.id, 'PAYIN', { dailyAmountMinor: 50_000n }); // ₹500
    const id = (await pay(m.owner, '400.00')).body.data.payment_id as string;
    expect((await pay(m.owner, '200.00')).body.error.code).toBe('LIMIT_EXCEEDED');

    const transitions = ctx.app.get(PaymentTransitionsService);
    await transitions.apply(id, { status: 'FAILED', failureCode: 'DECLINED', failureReason: 'test' }, 'CALLBACK');
    expect((await usage(m.id, 'PAYIN')).day).toMatchObject({ amountMinor: 0n, count: 0 });
    expect((await pay(m.owner, '200.00')).status).toBe(201);

    await transitions.apply(id, { status: 'SUCCESS', amountMinor: 40_000n, utr: 'UTR123456789' }, 'CALLBACK');
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCESS');
    expect((await usage(m.id, 'PAYIN')).day).toMatchObject({ amountMinor: 60_000n, count: 2 }); // money moved: counted even above the limit
  });

  it('payout limits are consumed under the merchant lock and released on rejection', async () => {
    const m = await createApprovedMerchant(ctx);
    const ledger = ctx.app.get(LedgerService);
    await ledger.run((tx) =>
      ledger.post(tx, {
        type: 'ADJUSTMENT_CREDIT',
        idempotencyKey: `test-fund:${randomUUID()}`,
        source: { type: 'ADJUSTMENT', id: `adj_${randomUUID()}` },
        description: 'Test funding',
        lines: [
          { accountCode: Accounts.ADJUSTMENT_SUSPENSE, direction: 'DEBIT', amountMinor: 1_000_000n, currency: 'INR' },
          { accountCode: Accounts.merchant(m.id, 'AVAILABLE'), direction: 'CREDIT', amountMinor: 1_000_000n, currency: 'INR' },
        ],
      }),
    );
    await limit(m.id, 'PAYOUT', { dailyAmountMinor: 100_000n });
    const payout = (amount: string) =>
      ctx.http().post('/v1/payouts').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: order(), amount, mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Ravi Menon', account_number: `7030${Date.now().toString().slice(-8)}1`, ifsc: 'HDFC0001234' } });
    const first = await payout('600.00');
    expect(first.status).toBe(202);
    expect((await payout('500.00')).body.error).toMatchObject({ code: 'LIMIT_EXCEEDED', message: 'Payout daily amount limit exceeded' });

    const t = ctx.app.get(PayoutTransitionsService);
    await t.ledgerRun(async (tx) => t.release(tx, await t.lock(tx, first.body.data.payout_id), 'REJECTED', { code: 'TEST', reason: 'test' }));
    expect((await usage(m.id, 'PAYOUT')).day).toMatchObject({ amountMinor: 0n, count: 0 });
    expect((await payout('500.00')).status).toBe(202);
  });
});
