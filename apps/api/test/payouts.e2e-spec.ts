import { randomUUID } from 'node:crypto';
import { newId } from '@pay2all/auth';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { BulkPayoutsService } from '../src/modules/payouts/bulk-payouts.service';
import { PayoutProcessorService } from '../src/modules/payouts/payout-processor.service';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let ops: string; // platform operations (payout.review)

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const orderId = (p = 'po') => `${p}_${randomUUID().slice(0, 12)}`;
let acct = 0;
/** Unique synthetic account numbers (never ending in 0000, which the mock treats as invalid). */
const accountNo = () => `5010${String(Date.now()).slice(-7)}${String(++acct).padStart(3, '0')}1`;

interface Merchant {
  id: string;
  owner: string; // maker, no MFA
  checkers: string[]; // MFA-verified approvers
  checkerNoMfa: string;
}

/** A fresh APPROVED merchant (no reseller) with a maker and MFA-enrolled checkers. */
async function newMerchant(fundRupees = 0): Promise<Merchant> {
  const platform = await orgBySlug(ctx, 'pay2all');
  const id = newId('organization');
  await ctx.prisma.organization.create({ data: { id, slug: `po-${id.slice(-10).toLowerCase()}`, name: `Payout Test ${id.slice(-6)}`, type: 'MERCHANT', parentId: platform.id } });
  await ctx.prisma.merchant.create({ data: { id, status: 'APPROVED', payinEnabled: true, payoutEnabled: true, approvedAt: new Date() } });
  await ctx.prisma.merchantProfile.create({ data: { merchantId: id, displayName: 'Payout Test' } });
  await ctx.prisma.merchantKyc.create({ data: { merchantId: id } });
  const owner = (await login(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: id })).email)).accessToken!;
  const checkers: string[] = [];
  for (let i = 0; i < 3; i++) checkers.push((await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: id })).email)).accessToken);
  const checkerNoMfa = (await login(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: id })).email)).accessToken!;
  if (fundRupees > 0) await fund(id, BigInt(Math.round(fundRupees * 100)));
  return { id, owner, checkers, checkerNoMfa };
}

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

const balance = async (merchantId: string, bucket: 'AVAILABLE' | 'RESERVED') => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, bucket) } }))?.balanceMinor ?? 0n;

function payout(token: string, body: Record<string, unknown>, idem = key()) {
  return ctx.http().post('/v1/payouts').set(bearer(token)).set('Idempotency-Key', idem).send(body);
}
const imps = (amount: string, extra: Record<string, unknown> = {}) => ({
  merchant_order_id: orderId(),
  amount,
  mode: 'IMPS',
  purpose: 'VENDOR_PAYMENT',
  beneficiary: { name: 'Asha Kulkarni', account_number: accountNo(), ifsc: 'HDFC0001234' },
  ...extra,
});
const processor = () => ctx.app.get(PayoutProcessorService);
/** Run the processor for one payout only (other suites leave payouts queued). */
async function processNow(id: string) {
  await ctx.prisma.payout.updateMany({ where: { status: 'QUEUED', NOT: { id } }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  await ctx.prisma.payout.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
  await processor().processQueued();
}
async function pollNow(id: string) {
  await ctx.prisma.payout.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
  await processor().pollInFlight();
}
const get = (id: string) => ctx.prisma.payout.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
  for (const code of ['mock-payout', 'mock-payout-2']) {
    const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code } });
    await ctx.prisma.provider.update({ where: { id: p.id }, data: { config: { ...(p.config as object), auto_success_after_ms: 0 } } });
  }
});

afterAll(async () => {
  // Ledger invariant after every scenario: each journal balances; no non-negative account below zero;
  // maintained balances equal the sum of their entries.
  const unbalanced = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (
      SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END)) j`;
  expect(unbalanced[0]!.n).toBe(0n);
  const negative = await ctx.prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM ledger_accounts WHERE NOT allow_negative AND balance_minor < 0`;
  expect(negative[0]!.n).toBe(0n);
  const drift = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM ledger_accounts a
     WHERE a.balance_minor IS NOT NULL AND a.balance_minor <> COALESCE((
       SELECT SUM(CASE WHEN e.direction = a.normal_balance THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`;
  expect(drift[0]!.n).toBe(0n);
  await ctx.app.close();
});

describe('create and reserve', () => {
  it('reserves amount + fee + GST at creation and queues an auto-tier payout (₹5,000 → 5.00 + 0.90)', async () => {
    const m = await newMerchant(20_000);
    const res = await payout(m.owner, imps('5000.00'));
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', amount: '5000.00', fee: '5.00', tax: '0.90', total_debit: '5005.90', approvals_required: 0 });
    expect(res.body.data.beneficiary.account_number_masked).toMatch(/^X+\d{4}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/5010\d{11}/); // full account number never returned
    expect(await balance(m.id, 'AVAILABLE')).toBe(2_000_000n - 500_590n);
    expect(await balance(m.id, 'RESERVED')).toBe(500_590n);
  });

  it('rejects insufficient balance with no payout and no journal, and replays the 422', async () => {
    const m = await newMerchant(100);
    const idem = key();
    const body = imps('100.00'); // + 5.90 fee
    const r1 = await payout(m.owner, body, idem);
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const r2 = await payout(m.owner, body, idem);
    expect(r2.status).toBe(422);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(await ctx.prisma.payout.count({ where: { merchantId: m.id } })).toBe(0);
    expect(await ctx.prisma.ledgerJournal.count({ where: { type: 'PAYOUT_RESERVE', entries: { some: { account: { code: Accounts.merchant(m.id, 'AVAILABLE') } } } } })).toBe(0);
    expect(await balance(m.id, 'AVAILABLE')).toBe(10_000n);
  });

  it('50 concurrent payouts of 10% of the balance: exactly 10 reserve, AVAILABLE ends at 0', async () => {
    const m = await newMerchant();
    await fund(m.id, 10n * 100_590n); // 10 × (₹1,000 + ₹5.90)
    const results = await Promise.all(Array.from({ length: 50 }, () => payout(m.owner, imps('1000.00'))));
    const ok = results.filter((r) => r.status === 202);
    const insufficient = results.filter((r) => r.body?.error?.code === 'INSUFFICIENT_BALANCE');
    expect(ok).toHaveLength(10);
    expect(insufficient).toHaveLength(40);
    expect(await balance(m.id, 'AVAILABLE')).toBe(0n);
    expect(await balance(m.id, 'RESERVED')).toBe(1_005_900n);
  }, 60_000);

  it('same key ×20 in parallel → one payout and one reserve; new key same order → DUPLICATE_ORDER; changed body → conflict', async () => {
    const m = await newMerchant(10_000);
    const idem = key();
    const body = imps('250.00');
    const results = await Promise.all(Array.from({ length: 20 }, () => payout(m.owner, body, idem)));
    for (const r of results) expect([202, 409]).toContain(r.status);
    expect(await ctx.prisma.payout.count({ where: { merchantId: m.id } })).toBe(1);
    const p = await ctx.prisma.payout.findFirstOrThrow({ where: { merchantId: m.id } });
    expect(await ctx.prisma.ledgerJournal.count({ where: { idempotencyKey: `payout:${p.id}:reserve` } })).toBe(1);
    expect((await payout(m.owner, body)).body.error.code).toBe('DUPLICATE_ORDER');
    expect((await payout(m.owner, { ...body, amount: '251.00' }, idem)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects JSON-number amounts and mode violations before reserving', async () => {
    const m = await newMerchant(10_000);
    expect((await payout(m.owner, { ...imps('1.00'), amount: 100 })).status).toBe(400);
    expect((await payout(m.owner, { ...imps('5000.00'), mode: 'RTGS' })).status).toBe(400); // RTGS min ₹2L
    expect((await payout(m.owner, { ...imps('10.00'), mode: 'UPI' })).status).toBe(400); // needs upi_id
    expect(await balance(m.id, 'RESERVED')).toBe(0n);
  });

  it('enforces merchant state', async () => {
    const m = await newMerchant(1_000);
    await ctx.prisma.merchant.update({ where: { id: m.id }, data: { payoutEnabled: false } });
    expect((await payout(m.owner, imps('10.00'))).body.error.code).toBe('PAYOUT_DISABLED');
  });
});

describe('beneficiaries', () => {
  it('reuses inline beneficiaries, stores the account encrypted and never exposes it', async () => {
    const m = await newMerchant(10_000);
    const account = accountNo();
    const b = { name: 'Vendor One', account_number: account, ifsc: 'ICIC0004321' };
    const a1 = await payout(m.owner, imps('10.00', { beneficiary: b }));
    const a2 = await payout(m.owner, imps('11.00', { beneficiary: b }));
    expect(a1.body.data.beneficiary.beneficiary_id).toBe(a2.body.data.beneficiary.beneficiary_id);
    const row = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: a1.body.data.beneficiary.beneficiary_id } });
    expect(row.accountNumberEncrypted).not.toContain(account);
    expect(row.bankName).toBe('ICICI Bank');
    const list = await ctx.http().get('/v1/beneficiaries').set(bearer(m.owner));
    expect(JSON.stringify(list.body)).not.toContain(account);
    const audits = await ctx.prisma.auditLog.findMany({ where: { organizationId: m.id } });
    expect(JSON.stringify(audits)).not.toContain(account);
  });

  it('requires verification above ₹25,000; verification checks the registered name; blocked can’t be paid', async () => {
    const m = await newMerchant(100_000);
    const created = await ctx.http().post('/v1/beneficiaries').set(bearer(m.owner)).send({ name: 'Big Vendor', account_number: accountNo(), ifsc: 'SBIN0001234' });
    expect(created.status).toBe(201);
    const id = created.body.data.beneficiary_id as string;
    const big = await payout(m.owner, { ...imps('30000.00'), beneficiary: { beneficiary_id: id } });
    expect(big.body.error.code).toBe('BENEFICIARY_NOT_VERIFIED');
    const v = await ctx.http().post(`/v1/beneficiaries/${id}/verify`).set(bearer(m.owner));
    expect(v.body.data).toMatchObject({ verification_status: 'VERIFIED', name_match_score: 100 });
    expect((await payout(m.owner, { ...imps('30000.00'), beneficiary: { beneficiary_id: id } })).status).toBe(202);

    const bad = await ctx.http().post('/v1/beneficiaries').set(bearer(m.owner)).send({ name: 'Ghost', account_number: '501000000000', ifsc: 'SBIN0001234' });
    const vb = await ctx.http().post(`/v1/beneficiaries/${bad.body.data.beneficiary_id}/verify`).set(bearer(m.owner));
    expect(vb.body.data.verification_status).toBe('FAILED');
    expect((await payout(m.owner, { ...imps('10.00'), beneficiary: { beneficiary_id: bad.body.data.beneficiary_id } })).body.error.code).toBe('BENEFICIARY_NOT_VERIFIED');

    await ctx.http().post(`/v1/beneficiaries/${id}/block`).set(bearer(m.owner)).send({ reason: 'Vendor offboarded' }).expect(200);
    expect((await payout(m.owner, { ...imps('10.00'), beneficiary: { beneficiary_id: id } })).body.error.code).toBe('BENEFICIARY_BLOCKED');
  });
});

describe('processing', () => {
  it('sends, polls to SUCCESS and settles exactly (RESERVED → clearing + fee + GST)', async () => {
    const m = await newMerchant(10_000);
    const id = (await payout(m.owner, imps('2000.00'))).body.data.payout_id as string;
    await processNow(id);
    expect((await get(id)).status).toBe('PENDING');
    const attempts = await ctx.prisma.payoutAttempt.findMany({ where: { payoutId: id } });
    expect(attempts).toMatchObject([{ attemptNo: 1, reference: `${id}-1`, status: 'ACCEPTED' }]);
    await pollNow(id);
    const p = await get(id);
    expect(p.status).toBe('SUCCESS');
    expect(p.utr).toMatch(/^\d{12}$/);
    const entries = await ctx.prisma.ledgerEntry.findMany({ where: { journalId: p.settleJournalId! }, include: { account: { select: { code: true } } } });
    expect(Object.fromEntries(entries.map((e) => [e.account.code, `${e.direction}:${e.amountMinor}`]))).toEqual({
      [Accounts.merchant(m.id, 'RESERVED')]: 'DEBIT:200590',
      [Accounts.providerClearing('mock-payout')]: 'CREDIT:200000',
      [Accounts.FEE_REVENUE]: 'CREDIT:500',
      [Accounts.GST_PAYABLE]: 'CREDIT:90',
    });
    expect(await balance(m.id, 'RESERVED')).toBe(0n);
    expect(await balance(m.id, 'AVAILABLE')).toBe(1_000_000n - 200_590n);
  });

  it('definitive failure after acceptance (.17) releases the reservation exactly', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.17'))).body.data.payout_id as string;
    await processNow(id);
    await pollNow(id);
    const p = await get(id);
    expect(p).toMatchObject({ status: 'FAILED', failureCode: 'ACCOUNT_CLOSED' });
    expect(p.releaseJournalId).not.toBeNull();
    expect(await balance(m.id, 'AVAILABLE')).toBe(100_000n);
    expect(await balance(m.id, 'RESERVED')).toBe(0n);
  });

  it('pre-acceptance rejection (.13) fails over, then fails and releases', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.13'))).body.data.payout_id as string;
    await processNow(id);
    expect((await get(id)).status).toBe('FAILED');
    const attempts = await ctx.prisma.payoutAttempt.findMany({ where: { payoutId: id }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => `${a.reference}:${a.status}`)).toEqual([`${id}-1:FAILED`, `${id}-2:FAILED`]);
    expect(await balance(m.id, 'AVAILABLE')).toBe(100_000n);
  });

  it('providers unreachable (.99) requeues instead of failing — nothing was sent', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.99'))).body.data.payout_id as string;
    await processNow(id);
    const p = await get(id);
    expect(p).toMatchObject({ status: 'QUEUED', requeueCount: 1 });
    expect(await balance(m.id, 'RESERVED')).toBe(10_689n);
  });

  it('ambiguous timeout (.77): stays PROCESSING, never re-sent with a new reference or provider, then manual review', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.77'))).body.data.payout_id as string;
    await processNow(id);
    expect((await get(id)).status).toBe('PROCESSING');
    await pollNow(id);
    await pollNow(id);
    const attempts = await ctx.prisma.payoutAttempt.findMany({ where: { payoutId: id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'UNKNOWN', reference: `${id}-1` });
    // Past the unknown-outcome window → manual review, funds still reserved.
    await ctx.prisma.payoutAttempt.update({ where: { id: attempts[0]!.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    await pollNow(id);
    expect((await get(id)).status).toBe('MANUAL_REVIEW');
    expect(await balance(m.id, 'RESERVED')).toBe(10_667n);
    // Merchants can't resolve; platform needs evidence.
    expect((await ctx.http().post(`/v1/payouts/${id}/review/resolve`).set(bearer(m.owner)).send({ outcome: 'FAILED', reason: 'bank says not debited' })).status).toBe(403);
    expect((await ctx.http().post(`/v1/payouts/${id}/review/resolve`).set(bearer(ops)).send({ outcome: 'SUCCESS', reason: 'Bank statement shows the debit on 6 Oct' })).status).toBe(400); // UTR required
    const resolved = await ctx.http().post(`/v1/payouts/${id}/review/resolve`).set(bearer(ops)).send({ outcome: 'FAILED', reason: 'Provider confirmed in writing that it was never processed' });
    expect(resolved.body.data.status).toBe('FAILED');
    expect(await balance(m.id, 'AVAILABLE')).toBe(100_000n);
  });

  it('bank return after success (.88) posts a reversal and restores the principal (fee kept)', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.88'))).body.data.payout_id as string;
    await processNow(id);
    await ctx.http().post(`/v1/sandbox/payouts/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'SUCCESS' }).expect(200);
    expect((await get(id)).status).toBe('SUCCESS');
    const sandbox = await ctx.http().post(`/v1/sandbox/payouts/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'REVERSED' });
    expect(sandbox.status).toBe(200);
    const p = await get(id);
    expect(p.status).toBe('REVERSED');
    const rev = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { id: p.reversalJournalId! } });
    expect(rev.type).toBe('PAYOUT_REVERSAL');
    expect(await balance(m.id, 'AVAILABLE')).toBe(100_000n - 590n); // principal back, ₹5.90 fee kept
    // A duplicate callback is a no-op.
    await ctx.http().post(`/v1/sandbox/payouts/${id}/complete`).set(bearer(m.owner)).send({ outcome: 'REVERSED' }).expect(200);
    expect(await ctx.prisma.ledgerJournal.count({ where: { idempotencyKey: `payout:${id}:reversal` } })).toBe(1);
  });

  it('recovers from a crash between claim and provider call without a duplicate transfer', async () => {
    const m = await newMerchant(1_000);
    const id = (await payout(m.owner, imps('100.00'))).body.data.payout_id as string;
    // Simulate: txn A committed (PROCESSING + INITIATED attempt), process died before the call.
    const p = await get(id);
    await ctx.prisma.payout.update({ where: { id }, data: { status: 'PROCESSING', version: { increment: 1 } } });
    const mockId = (await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-payout' } })).id;
    await ctx.prisma.payoutAttempt.create({ data: { id: newId('payoutAttempt'), payoutId: id, attemptNo: 1, providerId: mockId, reference: `${id}-1`, createdAt: new Date(Date.now() - 5 * 60_000) } });
    // Provider without guaranteed reference lookup: NOT_FOUND is not proof → nothing re-sent.
    await pollNow(id);
    expect((await get(id)).status).toBe('PROCESSING');
    expect(await ctx.prisma.payoutAttempt.count({ where: { payoutId: id } })).toBe(1);
    // With a lookup guarantee, NOT_FOUND proves it was never received → re-send with the SAME reference.
    const prov = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: mockId } });
    await ctx.prisma.provider.update({ where: { id: mockId }, data: { capabilities: { ...(prov.capabilities as object), supports_reference_lookup: true } } });
    try {
      await pollNow(id);
    } finally {
      await ctx.prisma.provider.update({ where: { id: mockId }, data: { capabilities: prov.capabilities as object } });
    }
    const attempts = await ctx.prisma.payoutAttempt.findMany({ where: { payoutId: id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ reference: `${id}-1`, status: 'ACCEPTED' });
    expect((await get(id)).status).not.toBe('FAILED');
    expect(p.totalDebitMinor).toBe(10_590n);
  });
});

describe('maker-checker', () => {
  it('needs an approver for ₹10,000.01–₹1,00,000; blocks self-approval and non-MFA sessions', async () => {
    const m = await newMerchant(50_000);
    const res = await payout(m.owner, imps('20000.00'));
    expect(res.body.data).toMatchObject({ status: 'APPROVAL_PENDING', approvals_required: 1 });
    const id = res.body.data.payout_id as string;
    expect(await balance(m.id, 'RESERVED')).toBe(2_000_590n); // reserved while awaiting approval

    const self = await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.owner)).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    expect((await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkerNoMfa)).send({})).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const mine = await ctx.http().get('/v1/payouts').query({ awaiting_my_approval: 'true' }).set(bearer(m.checkers[0]!));
    expect(mine.body.data.map((p: { payout_id: string }) => p.payout_id)).toContain(id);

    const ok = await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkers[0]!)).send({ reason: 'Invoice verified' });
    expect(ok.body.data).toMatchObject({ status: 'QUEUED', approvals_received: 1 });
    expect(ok.body.data.approvals[0]).toMatchObject({ decision: 'APPROVED', reason: 'Invoice verified' });
    expect((await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkers[1]!)).send({})).status).toBe(409); // not pending anymore
  });

  it('two approvers above ₹1,00,000: double votes rejected, racing final approvals queue exactly once', async () => {
    const m = await newMerchant(300_000);
    const ben = await ctx.http().post('/v1/beneficiaries').set(bearer(m.owner)).send({ name: 'Large Vendor', account_number: accountNo(), ifsc: 'UTIB0000001' });
    await ctx.http().post(`/v1/beneficiaries/${ben.body.data.beneficiary_id}/verify`).set(bearer(m.owner)).expect(200);
    const res = await payout(m.owner, { ...imps('150000.00'), beneficiary: { beneficiary_id: ben.body.data.beneficiary_id } });
    const id = res.body.data.payout_id as string;
    expect(res.body.data.approvals_required).toBe(2);

    // Tier is frozen: tightening the policy later doesn't change this payout.
    await ctx.prisma.approvalPolicy.create({ data: { id: newId('approvalPolicy'), level: 'MERCHANT', subjectId: m.id, service: 'PAYOUT', tiers: [{ up_to_minor: null, approvals_required: 3 }] } });
    expect((await get(id)).approvalsRequired).toBe(2);

    await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkers[0]!)).send({}).expect(200);
    const again = await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkers[0]!)).send({});
    expect(again.status).toBe(409);
    const race = await Promise.all([1, 2].map((i) => ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(m.checkers[i]!)).send({})));
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const p = await get(id);
    expect(p).toMatchObject({ status: 'QUEUED', approvalsReceived: 2 });
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: id, type: 'payout.queued' } })).toBe(1);
  });

  it('reject and approval expiry release the reservation', async () => {
    const m = await newMerchant(50_000);
    const a = (await payout(m.owner, imps('15000.00'))).body.data.payout_id as string;
    const b = (await payout(m.owner, imps('16000.00'))).body.data.payout_id as string;
    const rej = await ctx.http().post(`/v1/payouts/${a}/reject`).set(bearer(m.checkers[0]!)).send({ reason: 'Duplicate invoice' });
    expect(rej.body.data).toMatchObject({ status: 'REJECTED', failure_code: 'REJECTED_BY_APPROVER' });
    await ctx.prisma.payout.update({ where: { id: b }, data: { approvalExpiresAt: new Date(Date.now() - 1000) } });
    await processor().expireApprovals();
    expect(await get(b)).toMatchObject({ status: 'REJECTED', failureCode: 'APPROVAL_EXPIRED' });
    expect(await balance(m.id, 'AVAILABLE')).toBe(5_000_000n);
    expect(await balance(m.id, 'RESERVED')).toBe(0n);
  });

  it('approvals are append-only', async () => {
    const row = await ctx.prisma.payoutApproval.findFirstOrThrow();
    await expect(ctx.prisma.payoutApproval.update({ where: { id: row.id }, data: { reason: 'tampered' } })).rejects.toThrow();
  });
});

describe('tenancy', () => {
  it('hides other merchants’ payouts and beneficiaries', async () => {
    const a = await newMerchant(1_000);
    const b = await newMerchant(1_000);
    const res = await payout(a.owner, imps('100.00'));
    const id = res.body.data.payout_id as string;
    expect((await ctx.http().get(`/v1/payouts/${id}`).set(bearer(b.owner))).status).toBe(404);
    expect((await ctx.http().post(`/v1/payouts/${id}/approve`).set(bearer(b.checkers[0]!)).send({})).status).toBe(404);
    expect((await ctx.http().get(`/v1/beneficiaries/${res.body.data.beneficiary.beneficiary_id}`).set(bearer(b.owner))).status).toBe(404);
    // Another merchant's beneficiary id can't be used either.
    expect((await payout(b.owner, { ...imps('10.00'), beneficiary: { beneficiary_id: res.body.data.beneficiary.beneficiary_id } })).status).toBe(404);
  });
});

describe('bulk payouts', () => {
  const csv = (rows: string[]) => Buffer.from(['merchant_order_id,amount,mode,beneficiary_name,account_number,ifsc,upi_id,purpose,narration', ...rows].join('\n'));
  const upload = (token: string, body: Buffer, name = 'salaries.csv') => ctx.http().post('/v1/payouts/bulk').set(bearer(token)).attach('file', body, { filename: name, contentType: 'text/csv' });

  it('validates every row, refuses duplicates, and creates rows through the payout service after confirmation', async () => {
    const m = await newMerchant(100_000);
    const bad = await upload(m.owner, csv([`B-${randomUUID().slice(0, 6)},500.00,IMPS,Ravi K,${accountNo()},HDFC0001234,,SALARY,Oct salary`, 'B-X,abc,IMPS,Nope,1,BAD,,,', `B-${randomUUID().slice(0, 6)},300,UPI,Meera,,,meera@okaxis,,`]));
    expect(bad.body.data).toMatchObject({ status: 'VALIDATION_FAILED', total_rows: 3, valid_rows: 2 });
    expect(bad.body.data.rows[1].errors.length).toBeGreaterThan(0);
    expect((await ctx.http().post(`/v1/payouts/bulk/${bad.body.data.batch_id}/confirm`).set(bearer(m.checkers[0]!))).status).toBe(409);

    const file = csv([`B-${randomUUID().slice(0, 6)},5000.00,IMPS,Ravi K,${accountNo()},HDFC0001234,,SALARY,Oct salary`, `B-${randomUUID().slice(0, 6)},300,UPI,Meera,,,meera@okaxis,,`]);
    const ok = await upload(m.checkers[0]!, file);
    expect(ok.body.data).toMatchObject({ status: 'VALIDATED', valid_rows: 2, total_amount: '5300.00' });
    expect(JSON.stringify(ok.body)).not.toMatch(/5010\d{11}/);
    expect((await upload(m.checkers[0]!, file)).status).toBe(409); // same file twice

    const batchId = ok.body.data.batch_id as string;
    expect((await ctx.http().post(`/v1/payouts/bulk/${batchId}/confirm`).set(bearer(m.owner))).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const confirmed = await ctx.http().post(`/v1/payouts/bulk/${batchId}/confirm`).set(bearer(m.checkers[0]!));
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', approvals_required: 0 });
    await ctx.app.get(BulkPayoutsService).processConfirmed();
    const done = await ctx.http().get(`/v1/payouts/bulk/${batchId}`).set(bearer(m.owner));
    expect(done.body.data).toMatchObject({ status: 'COMPLETED', created_count: 2 });
    const payouts = await ctx.prisma.payout.findMany({ where: { bulkBatchId: batchId } });
    expect(payouts.map((p) => p.source)).toEqual(['BULK', 'BULK']);
    expect(payouts.every((p) => p.status === 'QUEUED')).toBe(true);
    // Re-running the batch is a no-op (idempotent per row).
    await ctx.prisma.bulkPayoutBatch.update({ where: { id: batchId }, data: { status: 'CONFIRMED' } });
    await ctx.app.get(BulkPayoutsService).processConfirmed();
    expect(await ctx.prisma.payout.count({ where: { bulkBatchId: batchId } })).toBe(2);
  });

  it('applies the batch-total tier to every row, approvable in one action by another checker', async () => {
    const m = await newMerchant(100_000);
    const rows = Array.from({ length: 3 }, () => `B-${randomUUID().slice(0, 6)},4000.00,IMPS,Staff Member,${accountNo()},KKBK0000123,,SALARY,`);
    const ok = await upload(m.checkers[0]!, csv(rows)); // total ₹12,000 → 1 approver per row
    const batchId = ok.body.data.batch_id as string;
    await ctx.http().post(`/v1/payouts/bulk/${batchId}/confirm`).set(bearer(m.checkers[0]!)).expect(200);
    await ctx.app.get(BulkPayoutsService).processConfirmed();
    const pending = await ctx.prisma.payout.findMany({ where: { bulkBatchId: batchId } });
    expect(pending.every((p) => p.status === 'APPROVAL_PENDING' && p.approvalsRequired === 1)).toBe(true);
    // The confirmer is the maker of every row and can't approve them.
    expect((await ctx.http().post(`/v1/payouts/bulk/${batchId}/approve`).set(bearer(m.checkers[0]!)).send({})).body.data.decided).toBe(0);
    const all = await ctx.http().post(`/v1/payouts/bulk/${batchId}/approve`).set(bearer(m.checkers[1]!)).send({});
    expect(all.body.data.decided).toBe(3);
    expect(await ctx.prisma.payout.count({ where: { bulkBatchId: batchId, status: 'QUEUED' } })).toBe(3);
  });
});
