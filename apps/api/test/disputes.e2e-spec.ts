import { randomUUID } from 'node:crypto';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let riskOps: string; // platform Operations (dispute.manage)
let support: string; // platform Support (dispute.read only)
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const bal = async (merchantId: string, bucket: 'AVAILABLE' | 'UNSETTLED' | 'RECEIVABLE' | 'LIEN') => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, bucket) } }))?.balanceMinor ?? 0n;
const buckets = async (id: string) => ({ available: await bal(id, 'AVAILABLE'), unsettled: await bal(id, 'UNSETTLED'), receivable: await bal(id, 'RECEIVABLE'), lien: await bal(id, 'LIEN') });

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  riskOps = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
  support = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  const unbalanced = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END)) j`;
  expect(unbalanced[0]!.n).toBe(0n);
  await ctx.app.close();
});

/** A merchant with a captured (unsettled) payment, and a merchant Finance user who responds. */
async function setup(amount = '1000.00') {
  const m = await createApprovedMerchant(ctx);
  const pay = await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `ord_${randomUUID().slice(0, 10)}`, amount, method: 'UPI', customer: { name: 'Asha', mobile: '9876500011' } });
  expect(pay.status).toBe(201);
  await ctx.http().post(`/v1/sandbox/payments/${pay.body.data.payment_id}/complete`).set(bearer(m.owner)).send({ outcome: 'SUCCESS' }).expect(200);
  const finance = (await login(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id })).email)).accessToken!;
  return { m, paymentId: pay.body.data.payment_id as string, finance };
}

describe('disputes', () => {
  it('open → hold → evidence → won: the hold returns exactly where it came from', async () => {
    const { m, paymentId, finance } = await setup('1000.00');
    const before = await buckets(m.id);
    const p0 = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(before.unsettled).toBe(p0.netAmountMinor);

    const opened = await ctx.http().post('/v1/admin/disputes').set(bearer(riskOps)).send({ payment_id: paymentId, reason_code: '10.4', reason: 'Customer says the order never arrived', respond_by_days: 5, provider_case_id: 'NPCI-778899' });
    expect(opened.status).toBe(201);
    expect(opened.body.data).toMatchObject({ status: 'OPEN', amount: '1000.00', reason_code: '10.4', payment: { id: paymentId } });
    const id = opened.body.data.id as string;
    // Held: AVAILABLE (empty) → UNSETTLED (the payment's net) → the rest as RECEIVABLE (the fees).
    const held = await buckets(m.id);
    expect(held).toEqual({ available: 0n, unsettled: 0n, receivable: 100_000n - p0.netAmountMinor, lien: 100_000n });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('DISPUTED');
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: id, type: 'dispute.created' } })).toBe(1);
    expect(await ctx.prisma.inboxNotification.count({ where: { organizationId: m.id, resourceId: id, category: 'DISPUTE' } })).toBeGreaterThan(0);
    expect((await ctx.http().post('/v1/admin/disputes').set(bearer(riskOps)).send({ payment_id: paymentId, reason_code: 'X', reason: 'Second attempt' })).status).toBe(409);

    // Merchant evidence: only real PDFs/images; then submit with a note.
    expect((await ctx.http().post(`/v1/disputes/${id}/submit`).set(bearer(finance)).send({ note: 'Delivered on 3 Oct, signed by customer.' })).status).toBe(400);
    expect((await ctx.http().post(`/v1/disputes/${id}/evidence`).set(bearer(finance)).attach('file', Buffer.from('<html>'), { filename: 'x.html', contentType: 'text/html' })).status).toBe(400);
    const ev = await ctx.http().post(`/v1/disputes/${id}/evidence`).set(bearer(finance)).field('description', 'Signed delivery receipt').attach('file', PDF, { filename: 'pod.pdf', contentType: 'application/pdf' });
    expect(ev.status).toBe(201);
    expect(ev.body.data.evidence).toHaveLength(1);
    const file = await ctx.http().get(`/v1/disputes/${id}/evidence/${ev.body.data.evidence[0].id}`).set(bearer(riskOps));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const sub = await ctx.http().post(`/v1/disputes/${id}/submit`).set(bearer(finance)).send({ note: 'Delivered on 3 Oct, signed by customer.' });
    expect(sub.body.data).toMatchObject({ status: 'UNDER_REVIEW', merchant_note: 'Delivered on 3 Oct, signed by customer.' });
    expect((await ctx.http().post(`/v1/disputes/${id}/evidence`).set(bearer(finance)).attach('file', PDF, { filename: 'late.pdf', contentType: 'application/pdf' })).status).toBe(409);

    // Support can read but not decide.
    expect((await ctx.http().get(`/v1/disputes/${id}`).set(bearer(support))).status).toBe(200);
    expect((await ctx.http().post(`/v1/admin/disputes/${id}/resolve`).set(bearer(support)).send({ outcome: 'WON', note: 'Evidence accepted' })).status).toBe(403);

    const won = await ctx.http().post(`/v1/admin/disputes/${id}/resolve`).set(bearer(riskOps)).send({ outcome: 'WON', note: 'Bank accepted the delivery proof' });
    expect(won.status).toBe(200);
    expect(won.body.data).toMatchObject({ status: 'WON', fee: '0.00' });
    expect(await buckets(m.id)).toEqual(before);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('SUCCESS');
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: id, type: 'dispute.won' } })).toBe(1);
  });

  it('lost: the amount goes to the provider and the fee + 18% GST is recovered; the payment ends as CHARGEBACK', async () => {
    const { m, paymentId } = await setup('2000.00');
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
    const opened = await ctx.http().post('/v1/admin/disputes').set(bearer(riskOps)).send({ payment_id: paymentId, amount: '1500.00', reason_code: 'FRAUD', reason: 'Cardholder does not recognise the transaction' });
    const id = opened.body.data.id as string;
    const lost = await ctx.http().post(`/v1/admin/disputes/${id}/resolve`).set(bearer(riskOps)).send({ outcome: 'LOST', note: 'No evidence received', fee: '200.00' });
    expect(lost.body.data).toMatchObject({ status: 'LOST', fee: '200.00', tax: '36.00' });
    const after = await buckets(m.id);
    expect(after.lien).toBe(0n);
    // 1,500 frozen from UNSETTLED (the payment's ~1,995 net is still unsettled); the 236 fee + GST
    // finds AVAILABLE empty, so the merchant owes it (RECEIVABLE).
    expect(p.netAmountMinor).toBeGreaterThan(150_000n);
    expect(after.unsettled).toBe(p.netAmountMinor - 150_000n);
    expect(after.receivable).toBe(23_600n);
    // The disputed amount goes back to the provider (credit to its clearing account), fee to revenue + GST.
    const d = await ctx.prisma.dispute.findUniqueOrThrow({ where: { id } });
    const entries = await ctx.prisma.ledgerEntry.findMany({ where: { journalId: d.outcomeJournalId! }, include: { account: { select: { code: true } } } });
    expect(entries.map((e) => [e.direction, e.amountMinor, e.account.code]).sort()).toEqual(
      [
        ['CREDIT', 150_000n, Accounts.providerClearing(provider.code)],
        ['CREDIT', 20_000n, Accounts.FEE_REVENUE],
        ['CREDIT', 3_600n, Accounts.GST_PAYABLE],
        ['DEBIT', 150_000n, Accounts.merchant(m.id, 'LIEN')],
        ['DEBIT', 23_600n, Accounts.merchant(m.id, 'RECEIVABLE')],
      ].sort(),
    );
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('CHARGEBACK');
    expect((await ctx.http().post('/v1/admin/disputes').set(bearer(riskOps)).send({ payment_id: paymentId, reason_code: 'X', reason: 'Again please' })).status).toBe(409);
  });

  it('the merchant can accept instead of contesting; other merchants and merchants opening disputes are refused', async () => {
    const { m, paymentId, finance } = await setup('500.00');
    const id = (await ctx.http().post('/v1/admin/disputes').set(bearer(riskOps)).send({ payment_id: paymentId, reason_code: 'DUP', reason: 'Charged twice for one order' })).body.data.id as string;
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().get(`/v1/disputes/${id}`).set(bearer(other.owner))).status).toBe(404);
    expect((await ctx.http().post('/v1/admin/disputes').set(bearer(m.owner)).send({ payment_id: paymentId, reason_code: 'X', reason: 'Trying to open' })).status).toBe(403);
    const accepted = await ctx.http().post(`/v1/disputes/${id}/accept`).set(bearer(finance)).send({ note: 'Customer is right, it was a duplicate.' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: 'LOST', accepted: true, fee: '0.00' });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('CHARGEBACK');
    expect((await bal(m.id, 'LIEN'))).toBe(0n);
    const summary = await ctx.http().get('/v1/disputes/summary').set(bearer(m.owner));
    expect(summary.body.data).toMatchObject({ open: 0, lost: 1 });
  });
});
