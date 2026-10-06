import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import { cutoffInstant, istDate } from '../src/modules/settlements/settlement-schedule';
import { SettlementsService } from '../src/modules/settlements/settlements.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let finance: string; // platform FINANCE (settlement.process, reconciliation.manage)

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const svc = () => ctx.app.get(SettlementsService);
const balance = async (merchantId: string, bucket: 'AVAILABLE' | 'UNSETTLED' | 'SETTLED') => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, bucket) } }))?.balanceMinor ?? 0n;
/** 19:00 IST today: after the default 18:00 cutoff, so today's run is due. */
const runAt = () => new Date(cutoffInstant(istDate(new Date()), 19 * 60).getTime());
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function capture(token: string, amount: string, successAt?: Date) {
  const res = await ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key()).send({ merchant_order_id: `o_${randomUUID().slice(0, 12)}`, amount, method: 'UPI' });
  const id = res.body.data.payment_id as string;
  const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id } });
  const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
  const secret = (await ctx.app.get(ProviderRegistryService).context(provider)).credentials.webhook_secret!;
  const body = JSON.stringify({ event_id: `ev_${randomUUID()}`, type: 'payment.status', data: { reference: id, provider_order_id: p.providerOrderId, status: 'SUCCESS', amount_minor: p.amountMinor.toString(), utr: String(Date.now()).slice(-12) } });
  await ctx.http().post(`/v1/webhooks/providers/${provider.code}`).set('Content-Type', 'application/json').set('X-Mock-Signature', createHmac('sha256', secret).update(body).digest('hex')).send(body).expect(200);
  if (successAt) await ctx.prisma.payment.update({ where: { id }, data: { successAt } });
  return id;
}

async function config(merchantId: string, destination: 'WALLET' | 'BANK', extra: Record<string, unknown> = {}) {
  const res = await ctx.http().put(`/v1/settlements/config/${merchantId}`).set(bearer(finance)).send({ cycle: 'T1', cutoff_time: '18:00', min_amount: '1.00', destination, auto_settle: true, reason: 'Test configuration', ...extra });
  expect(res.status).toBe(200);
}

async function verifiedBank(merchantId: string, account = '50100555666777') {
  const enc = ctx.app.get(FieldEncryptor);
  await ctx.prisma.merchantBankAccount.create({ data: { id: newId('bankAccount'), merchantId, accountHolderName: 'Test Merchant Pvt Ltd', accountNumberEncrypted: enc.encrypt(account, merchantId), accountNumberMasked: `XXXXXXXXXX${account.slice(-4)}`, accountNumberHash: enc.blindIndex(account, 'bank-account'), ifsc: 'HDFC0001234', bankName: 'HDFC Bank', verificationStatus: 'VERIFIED', verifiedAt: new Date(), isPrimary: true } });
}

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  finance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('settlement generation', () => {
  it('settles to the wallet exactly what earlier payments left in UNSETTLED, keeping later payments’ share', async () => {
    const m = await createApprovedMerchant(ctx);
    await config(m.id, 'WALLET');
    const a = await capture(m.owner, '1000.00', daysAgo(2)); // net 997.88 → eligible
    const b = await capture(m.owner, '100.00'); // net 99.79 → captured after the cutoff, stays
    expect(await balance(m.id, 'UNSETTLED')).toBe(99_788n + 9_979n);
    const out = await svc().generateFor(m.id, runAt());
    expect(out).toMatchObject({ result: 'CREATED', netMinor: 99_788n });
    const s = await ctx.prisma.settlement.findFirstOrThrow({ where: { merchantId: m.id } });
    expect(s).toMatchObject({ status: 'PROCESSED', destination: 'WALLET', paymentCount: 1, grossMinor: 100_000n, feeMinor: 180n, taxMinor: 32n });
    expect(await balance(m.id, 'UNSETTLED')).toBe(9_979n);
    expect(await balance(m.id, 'AVAILABLE')).toBe(99_788n);
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: 'SETTLED', settlementId: s.id });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: b } })).settlementId).toBeNull();
    // Same date again: no second settlement.
    expect(await svc().generateFor(m.id, runAt())).toMatchObject({ result: 'SKIPPED', reason: 'Already settled for this date' });
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: s.id, type: 'settlement.processed' } })).toBe(1);
  });

  it('never goes negative when a later payment’s refund drew on the pooled balance', async () => {
    const m = await createApprovedMerchant(ctx);
    await config(m.id, 'WALLET');
    await capture(m.owner, '1000.00', daysAgo(2));
    const b = await capture(m.owner, '100.00');
    const r = await ctx.http().post(`/v1/payments/${b}/refunds`).set(bearer(m.owner)).set('Idempotency-Key', key()).send({ amount: '100.00' });
    expect(r.status).toBe(201); // draws ₹100 from UNSETTLED (more than B's ₹99.79 net)
    const out = await svc().generateFor(m.id, runAt());
    expect(out).toMatchObject({ result: 'CREATED', netMinor: 99_788n + 9_979n - 10_000n });
    expect(await balance(m.id, 'UNSETTLED')).toBe(0n);
  });

  it('skips before the cutoff, under a hold, below the minimum, and when nothing is due', async () => {
    const m = await createApprovedMerchant(ctx);
    await config(m.id, 'WALLET', { min_amount: '500.00' });
    await capture(m.owner, '100.00', daysAgo(2));
    const before = new Date(cutoffInstant(istDate(new Date()), 17 * 60).getTime());
    expect(await svc().generateFor(m.id, before)).toMatchObject({ result: 'SKIPPED', reason: 'Not due yet (before cutoff)' });
    expect((await svc().generateFor(m.id, runAt())).result === 'SKIPPED').toBe(true); // ₹99.79 < ₹500 minimum
    const hold = await ctx.http().post('/v1/settlements/holds').set(bearer(finance)).send({ merchant_id: m.id, reason: 'Chargeback investigation' });
    expect(hold.status).toBe(201);
    await config(m.id, 'WALLET');
    expect(await svc().generateFor(m.id, runAt())).toMatchObject({ result: 'SKIPPED', reason: 'Settlement hold is active' });
    await ctx.http().post(`/v1/settlements/holds/${hold.body.data.hold_id}/release`).set(bearer(finance)).send({ reason: 'Investigation closed' }).expect(200);
    expect((await svc().generateFor(m.id, runAt())).result).toBe('CREATED');
  });
});

describe('bank settlements', () => {
  it('holds funds in transit, then pays with a UTR (SETTLED memo), or returns them on failure', async () => {
    const m = await createApprovedMerchant(ctx);
    await config(m.id, 'BANK');
    expect(await svc().generateFor(m.id, runAt())).toMatchObject({ result: 'SKIPPED' }); // nothing yet
    await capture(m.owner, '1000.00', daysAgo(2));
    expect(await svc().generateFor(m.id, runAt())).toMatchObject({ result: 'SKIPPED', reason: 'No verified settlement bank account' });
    await verifiedBank(m.id);
    const out = await svc().generateFor(m.id, runAt());
    expect(out.result).toBe('CREATED');
    const s = await ctx.prisma.settlement.findFirstOrThrow({ where: { merchantId: m.id } });
    expect(s).toMatchObject({ status: 'PROCESSING', netMinor: 99_788n });
    expect((s.bankSnapshot as { account_number_masked: string }).account_number_masked).toBe('XXXXXXXXXX6777');
    expect(await balance(m.id, 'UNSETTLED')).toBe(0n);

    // Finance exports the transfer file (full account number, audited, MFA session).
    const file = await ctx.http().get('/v1/settlements/transfer-file').set(bearer(finance));
    expect(file.status).toBe(200);
    expect(file.text).toContain(`${s.id},${m.id},997.88,Test Merchant Pvt Ltd,50100555666777,HDFC0001234`);
    expect((await ctx.http().get('/v1/settlements/transfer-file').set(bearer(m.owner))).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'settlement.transfer_file.exported' } })).toBeGreaterThanOrEqual(1);

    const paid = await ctx.http().post(`/v1/settlements/${s.id}/paid`).set(bearer(finance)).send({ utr: 'HDFCN52026100700001' });
    expect(paid.body.data).toMatchObject({ status: 'PROCESSED', utr: 'HDFCN52026100700001' });
    expect(await balance(m.id, 'SETTLED')).toBe(99_788n);
    expect((await ctx.prisma.payment.findFirstOrThrow({ where: { settlementId: s.id } })).status).toBe('SETTLED');
    expect((await ctx.http().post(`/v1/settlements/${s.id}/paid`).set(bearer(finance)).send({ utr: 'AGAIN123456' })).status).toBe(409);
  });

  it('a failed transfer returns funds to UNSETTLED and the payments settle again next time', async () => {
    const m = await createApprovedMerchant(ctx);
    await config(m.id, 'BANK');
    await verifiedBank(m.id, '50100999000111');
    const p = await capture(m.owner, '500.00', daysAgo(2));
    await svc().generateFor(m.id, runAt());
    const s = await ctx.prisma.settlement.findFirstOrThrow({ where: { merchantId: m.id } });
    const failed = await ctx.http().post(`/v1/settlements/${s.id}/failed`).set(bearer(finance)).send({ reason: 'Beneficiary account frozen' });
    expect(failed.body.data.status).toBe('FAILED');
    expect(await balance(m.id, 'UNSETTLED')).toBe(s.netMinor);
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: p } })).toMatchObject({ status: 'SUCCESS', settlementId: null });
    const tomorrow = new Date(runAt().getTime() + 86_400_000);
    expect(await svc().generateFor(m.id, tomorrow)).toMatchObject({ result: 'CREATED', netMinor: s.netMinor });
  });
});

describe('access', () => {
  it('merchants see only their own settlements and cannot process them', async () => {
    const m = await createApprovedMerchant(ctx);
    const other = await createApprovedMerchant(ctx);
    await config(m.id, 'WALLET');
    await capture(m.owner, '200.00', daysAgo(2));
    await svc().generateFor(m.id, runAt());
    const s = await ctx.prisma.settlement.findFirstOrThrow({ where: { merchantId: m.id } });
    const mine = await ctx.http().get('/v1/settlements').set(bearer(m.owner));
    expect(mine.body.data.map((x: { settlement_id: string }) => x.settlement_id)).toContain(s.id);
    expect((await ctx.http().get(`/v1/settlements/${s.id}`).set(bearer(other.owner))).status).toBe(404);
    const detail = await ctx.http().get(`/v1/settlements/${s.id}`).set(bearer(m.owner));
    expect(detail.body.data.payments).toHaveLength(1);
    const csv = await ctx.http().get(`/v1/settlements/${s.id}/statement`).set(bearer(m.owner));
    expect(csv.text).toContain('net_settled,');
    expect((await ctx.http().post(`/v1/settlements/${s.id}/failed`).set(bearer(m.owner)).send({ reason: 'trying' })).status).toBe(403);
    expect((await ctx.http().put(`/v1/settlements/config/${m.id}`).set(bearer(m.owner)).send({})).status).toBe(403);
  });
});

describe('provider remittances', () => {
  it('posts PROVIDER_SETTLEMENT (bank + cost = clearing) once per reference', async () => {
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-upi' } });
    const ref = `UTR${Date.now()}`;
    const body = { provider_id: provider.id, reference: ref, value_date: istDate(new Date()), amount: '999.00', cost: '1.00' };
    const res = await ctx.http().post('/v1/settlements/remittances').set(bearer(finance)).send(body);
    expect(res.status).toBe(201);
    const j = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: `provider_stl:${provider.id}:${ref}` }, include: { entries: { include: { account: { select: { code: true } } } } } });
    expect(Object.fromEntries(j.entries.map((e) => [e.account.code, `${e.direction}:${e.amountMinor}`]))).toEqual({
      [Accounts.bank('nodal')]: 'DEBIT:99900',
      [Accounts.PROVIDER_COST]: 'DEBIT:100',
      [Accounts.providerClearing('mock-upi')]: 'CREDIT:100000',
    });
    expect((await ctx.http().post('/v1/settlements/remittances').set(bearer(finance)).send(body)).body.error.code).toBe('DUPLICATE_ORDER');
  });
});

describe('reconciliation', () => {
  it('classifies a provider statement and resolves a provider-confirmed payment through the state machine', async () => {
    const m = await createApprovedMerchant(ctx);
    const ok = await capture(m.owner, '300.00');
    const missing = await capture(m.owner, '310.00'); // captured, absent from the statement
    const amountOff = await capture(m.owner, '320.00');
    // Expired on our side, but the provider says the customer paid.
    const late = (await ctx.http().post('/v1/payments').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `o_${randomUUID().slice(0, 12)}`, amount: '330.00', method: 'UPI' })).body.data.payment_id as string;
    await ctx.prisma.payment.update({ where: { id: late }, data: { status: 'EXPIRED', failedAt: new Date(), version: { increment: 1 } } });
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-upi' } });
    const today = istDate(new Date());
    const csv = [
      'reference,amount,status,date,utr',
      `${ok},300.00,SUCCESS,${today},`,
      `${ok},300.00,SUCCESS,${today},`,
      `${amountOff},302.00,SUCCESS,${today},`,
      `${late},330.00,SUCCESS,${today},999988887777`,
      `pay_UNKNOWN${randomUUID().slice(0, 4)},50.00,SUCCESS,${today},`,
    ].join('\n');
    const up = await ctx.http().post('/v1/reconciliation/runs').set(bearer(finance)).field('provider_id', provider.id).field('kind', 'PAYIN').attach('file', Buffer.from(csv), { filename: 'mock-upi.csv', contentType: 'text/csv' });
    expect(up.status).toBe(201);
    expect(up.body.data.status).toBe('QUEUED');
    expect((await ctx.http().post('/v1/reconciliation/runs').set(bearer(finance)).field('provider_id', provider.id).field('kind', 'PAYIN').attach('file', Buffer.from(csv), { filename: 'again.csv', contentType: 'text/csv' })).status).toBe(409);

    while ((await ctx.app.get(ReconciliationService).processQueued()) > 0) {
      // drain (other suites may have queued runs)
    }
    const run = await ctx.http().get(`/v1/reconciliation/runs/${up.body.data.run_id}`).set(bearer(finance));
    expect(run.body.data).toMatchObject({ status: 'COMPLETED', total_rows: 5, matched: 1, duplicates: 1, missing_internal: 1 });
    const entries = (await ctx.http().get(`/v1/reconciliation/runs/${up.body.data.run_id}/entries`).query({ limit: 100 }).set(bearer(finance))).body.data as { entry_id: string; result: string; internal_id: string | null }[];
    const resultOf = (id: string) => entries.filter((e) => e.internal_id === id).map((e) => e.result);
    expect(resultOf(ok).sort()).toEqual(['DUPLICATE', 'MATCHED']);
    expect(resultOf(amountOff)).toEqual(['AMOUNT_MISMATCH']);
    expect(resultOf(late)).toEqual(['STATUS_MISMATCH']);
    expect(resultOf(missing)).toEqual(['MISSING_PROVIDER']);

    const lateEntry = entries.find((e) => e.internal_id === late)!;
    const amountEntry = entries.find((e) => e.internal_id === amountOff)!;
    expect((await ctx.http().post(`/v1/reconciliation/entries/${amountEntry.entry_id}/resolve`).set(bearer(finance)).send({ action: 'ACCEPT_PROVIDER_SUCCESS', note: 'Trying to accept a mismatch' })).status).toBe(400);
    const res = await ctx.http().post(`/v1/reconciliation/entries/${lateEntry.entry_id}/resolve`).set(bearer(finance)).send({ action: 'ACCEPT_PROVIDER_SUCCESS', note: 'Provider statement shows the credit with UTR 999988887777' });
    expect(res.body.data.resolution).toBe('RESOLVED');
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: late } })).toMatchObject({ status: 'SUCCESS', lateSuccess: true });
    expect((await ctx.http().post(`/v1/reconciliation/entries/${lateEntry.entry_id}/resolve`).set(bearer(finance)).send({ action: 'NOTE', note: 'Second resolution attempt' })).status).toBe(409);
    expect((await ctx.http().get('/v1/reconciliation/runs').set(bearer(m.owner))).status).toBe(403);
  });
});
