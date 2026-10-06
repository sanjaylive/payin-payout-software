import { newId } from '@pay2all/auth';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let ledger: LedgerService;
let financeToken: string;
let finance2Token: string;
let platformId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = ctx.app.get(LedgerService);
  platformId = (await orgBySlug(ctx, 'pay2all')).id;
  financeToken = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platformId })).email)).accessToken;
  finance2Token = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platformId })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

/** An APPROVED merchant with an owner login. */
async function approvedMerchant() {
  const id = newId('organization');
  await ctx.prisma.organization.create({ data: { id, type: 'MERCHANT', name: `Ledger Test ${id.slice(-6)}`, slug: `ledger-${id.slice(-10).toLowerCase()}`, parentId: platformId } });
  await ctx.prisma.merchant.create({ data: { id, status: 'APPROVED', payinEnabled: true, payoutEnabled: true } });
  const owner = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: id });
  return { id, ownerToken: (await login(ctx, owner.email)).accessToken! };
}

const INR = 'INR';

/** Capture a payin and settle it to the merchant's wallet: AVAILABLE += net. */
async function fund(merchantId: string, netMinor: bigint, tag = newId('payment')) {
  await ledger.run(async (tx) => {
    await ledger.post(tx, {
      type: 'PAYIN_CAPTURE',
      idempotencyKey: `payment:${tag}:capture`,
      source: { type: 'PAYMENT', id: tag },
      lines: [
        { accountCode: Accounts.providerClearing('mock'), direction: 'DEBIT', amountMinor: netMinor + 200n, currency: INR },
        { accountCode: Accounts.merchant(merchantId, 'UNSETTLED'), direction: 'CREDIT', amountMinor: netMinor, currency: INR },
        { accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: 169n, currency: INR },
        { accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: 31n, currency: INR },
      ],
    });
    await ledger.post(tx, {
      type: 'SETTLEMENT',
      idempotencyKey: `settlement:stl_${tag}`,
      source: { type: 'SETTLEMENT', id: `stl_${tag}` },
      lines: [
        { accountCode: Accounts.merchant(merchantId, 'UNSETTLED'), direction: 'DEBIT', amountMinor: netMinor, currency: INR },
        { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: netMinor, currency: INR },
      ],
    });
  });
}

const reserve = (merchantId: string, payoutId: string, amount: bigint) =>
  ledger.run((tx) =>
    ledger.post(tx, {
      type: 'PAYOUT_RESERVE',
      idempotencyKey: `payout:${payoutId}:reserve`,
      source: { type: 'PAYOUT', id: payoutId },
      lines: [
        { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'DEBIT', amountMinor: amount, currency: INR },
        { accountCode: Accounts.merchant(merchantId, 'RESERVED'), direction: 'CREDIT', amountMinor: amount, currency: INR },
      ],
    }),
  );

async function available(merchantId: string) {
  return (await ledger.merchantBalances(merchantId)).available;
}

describe('database guards', () => {
  it('rejects an unbalanced journal at COMMIT even when written with raw SQL', async () => {
    const before = await ctx.prisma.ledgerJournal.count();
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO ledger_accounts (id, code, name, type, normal_balance, owner_type, currency, updated_at)
                             VALUES ('lacc_rawtest1', 'platform:bank:rawtest', 'raw', 'ASSET', 'DEBIT', 'PLATFORM', 'INR', now()) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO ledger_journals (id, type, idempotency_key, lines_hash, source_type, source_id, effective_at)
                             VALUES ('jrnl_rawtest', 'REVERSAL', 'raw:test', 'x', 'SYSTEM', 'x', now())`;
        await tx.$executeRaw`INSERT INTO ledger_entries (id, journal_id, account_id, direction, amount_minor, currency)
                             VALUES ('lent_rawtest', 'jrnl_rawtest', 'lacc_rawtest1', 'DEBIT', 100, 'INR')`;
      }),
    ).rejects.toThrow(/fewer than 2 entries|unbalanced/);
    expect(await ctx.prisma.ledgerJournal.count()).toBe(before);
  });

  it('makes journals and entries immutable', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 10_000n);
    const entry = await ctx.prisma.ledgerEntry.findFirstOrThrow({ where: { account: { ownerId: id } } });
    await expect(ctx.prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.ledgerJournal.delete({ where: { id: entry.journalId } })).rejects.toThrow(/append-only/);
    // Account identity can't be changed either (e.g. flipping allow_negative to permit overdraft).
    await expect(ctx.prisma.ledgerAccount.update({ where: { id: entry.accountId }, data: { allowNegative: true } })).rejects.toThrow(/identity is immutable/);
  });
});

describe('posting', () => {
  it('posts the spec payout example exactly: merchant −₹10,005.90, clearing +₹10,000, fee ₹5, GST ₹0.90', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 5_000_000n);
    const payoutId = newId('payout');
    await reserve(id, payoutId, 1_000_590n);
    const settled = await ledger.run((tx) =>
      ledger.post(tx, {
        type: 'PAYOUT_SETTLE',
        idempotencyKey: `payout:${payoutId}:settle`,
        source: { type: 'PAYOUT', id: payoutId },
        lines: [
          { accountCode: Accounts.merchant(id, 'RESERVED'), direction: 'DEBIT', amountMinor: 1_000_590n, currency: INR },
          { accountCode: Accounts.providerClearing('mock'), direction: 'CREDIT', amountMinor: 1_000_000n, currency: INR },
          { accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: 500n, currency: INR },
          { accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: 90n, currency: INR },
        ],
      }),
    );
    expect(await available(id)).toBe('39994.10'); // 50,000.00 − 10,005.90
    expect((await ledger.merchantBalances(id)).reserved).toBe('0.00');
    const lines = settled.entries.map((e) => [e.accountCode.replace(id, 'M'), e.direction, e.amountMinor]);
    expect(lines).toEqual([
      ['merchant:M:RESERVED', 'DEBIT', 1_000_590n],
      ['platform:provider:mock:CLEARING', 'CREDIT', 1_000_000n],
      ['platform:FEE_REVENUE', 'CREDIT', 500n],
      ['platform:GST_PAYABLE', 'CREDIT', 90n],
    ]);
  });

  it('rejects overdrafts with INSUFFICIENT_BALANCE and writes nothing', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 10_000n);
    const journals = await ctx.prisma.ledgerJournal.count();
    await expect(reserve(id, newId('payout'), 10_001n)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await ctx.prisma.ledgerJournal.count()).toBe(journals);
    expect(await available(id)).toBe('100.00');
  });

  it('is idempotent: sequential and concurrent duplicates produce exactly one journal', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 100_000n);
    const payoutId = newId('payout');
    const first = await reserve(id, payoutId, 5_000n);
    const second = await reserve(id, payoutId, 5_000n);
    expect(second).toMatchObject({ journalId: first.journalId, replayed: true });
    const raced = await Promise.all(Array.from({ length: 6 }, () => reserve(id, payoutId, 5_000n)));
    expect(new Set(raced.map((r) => r.journalId)).size).toBe(1);
    expect(await ctx.prisma.ledgerJournal.count({ where: { idempotencyKey: `payout:${payoutId}:reserve` } })).toBe(1);
    expect(await available(id)).toBe('950.00');
    // Same key, different amount → conflict (a bug, never silently accepted).
    await expect(reserve(id, payoutId, 6_000n)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('never double-spends under concurrency: exactly k of N parallel reserves succeed', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 50_000n); // ₹500 → room for exactly 5 × ₹100
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => reserve(id, newId('payout'), 10_000n)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const insufficient = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'INSUFFICIENT_BALANCE').length;
    expect(ok).toBe(5);
    expect(insufficient).toBe(10);
    const balances = await ledger.merchantBalances(id);
    expect(balances.available).toBe('0.00');
    expect(balances.reserved).toBe('500.00');
    const verify = await ledger.verify();
    expect(verify.drift.filter((d) => d.code.includes(id))).toEqual([]);
  });

  it('reverses a wrong journal once, refuses reversal of a reversal, and refuses reversing spent funds', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 20_000n, 'pay_reversal_case');
    const settlement = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: 'settlement:stl_pay_reversal_case' } });
    const actorToken = financeToken;
    const rev = await ctx.http().post(`/v1/ledger/journals/${settlement.id}/reverse`).set(bearer(actorToken)).send({ reason: 'Settled to wallet by mistake' });
    expect(rev.status).toBe(200);
    expect(rev.body.data.type).toBe('REVERSAL');
    expect(rev.body.data.reverses_journal_id).toBe(settlement.id);
    expect(await available(id)).toBe('0.00');
    expect((await ledger.merchantBalances(id)).unsettled).toBe('200.00');

    const again = await ctx.http().post(`/v1/ledger/journals/${settlement.id}/reverse`).set(bearer(actorToken)).send({ reason: 'Trying a second reversal' });
    expect(again.body.data.id).toBe(rev.body.data.id); // idempotent, not a second mirror
    const ofReversal = await ctx.http().post(`/v1/ledger/journals/${rev.body.data.id}/reverse`).set(bearer(actorToken)).send({ reason: 'Undo the reversal please' });
    expect(ofReversal.status).toBe(400);

    // Spend, then try to reverse the funding: refused rather than going negative.
    const { id: m2 } = await approvedMerchant();
    await fund(m2, 10_000n, 'pay_spent_case');
    await reserve(m2, newId('payout'), 10_000n);
    const spent = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: 'settlement:stl_pay_spent_case' } });
    const refused = await ctx.http().post(`/v1/ledger/journals/${spent.id}/reverse`).set(bearer(actorToken)).send({ reason: 'Reverse after payout was made' });
    expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });
});

describe('integrity', () => {
  it('keeps the global trial balance at zero', async () => {
    const res = await ctx.http().get('/v1/ledger/trial-balance').set(bearer(financeToken));
    expect(res.body.data.balanced).toBe(true);
    expect(res.body.data.difference).toBe('0.00');
  });

  it('detects a corrupted running balance and freezes the merchant’s payouts', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 30_000n);
    // Simulate corruption outside the ledger (balance edited directly).
    await ctx.prisma.ledgerAccount.update({ where: { code: Accounts.merchant(id, 'AVAILABLE') }, data: { balanceMinor: 9_999_999n } });
    const res = await ctx.http().post('/v1/ledger/verify').set(bearer(financeToken));
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.drift.map((d: { code: string }) => d.code)).toContain(Accounts.merchant(id, 'AVAILABLE'));
    expect(res.body.data.payouts_frozen_for).toContain(id);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id } })).payoutEnabled).toBe(false);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ledger.drift_detected' } })).toBeGreaterThan(0);
    // Restore so later checks in this file see a consistent ledger.
    await ctx.prisma.ledgerAccount.update({ where: { code: Accounts.merchant(id, 'AVAILABLE') }, data: { balanceMinor: 30_000n } });
  });
});

describe('manual adjustments (maker-checker)', () => {
  it('requires an independent checker and posts a balanced journal on approval', async () => {
    const { id, ownerToken } = await approvedMerchant();
    const created = await ctx.http().post('/v1/ledger/adjustments').set(bearer(financeToken)).send({
      merchant_id: id, direction: 'CREDIT', amount: '250.00', reason: 'Goodwill credit for delayed settlement', reference: 'TICKET-1234',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'PENDING_APPROVAL', approvals_required: 1 });
    expect(await available(id)).toBe('0.00'); // nothing moves before approval

    const self = await ctx.http().post(`/v1/ledger/adjustments/${created.body.data.id}/approve`).set(bearer(financeToken)).send({});
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');

    const approved = await ctx.http().post(`/v1/ledger/adjustments/${created.body.data.id}/approve`).set(bearer(finance2Token)).send({ comment: 'Verified ticket' });
    expect(approved.body.data.status).toBe('POSTED');
    expect(await available(id)).toBe('250.00');
    const journal = await ctx.http().get(`/v1/ledger/journals/${approved.body.data.journal_id}`).set(bearer(financeToken));
    expect(journal.body.data.entries.map((e: { account_code: string; direction: string; amount: string }) => [e.account_code.replace(id, 'M'), e.direction, e.amount])).toEqual(
      expect.arrayContaining([['platform:ADJUSTMENT_SUSPENSE', 'DEBIT', '250.00'], ['merchant:M:AVAILABLE', 'CREDIT', '250.00']]),
    );
    // The merchant sees the credit in its own statement, but not platform-side lines.
    const own = await ctx.http().get(`/v1/ledger/journals/${approved.body.data.journal_id}`).set(bearer(ownerToken));
    expect(own.body.data.entries).toHaveLength(1);
    expect(own.body.data.idempotency_key).toBeUndefined();
  });

  it('cannot overdraw with a debit adjustment; the approval rolls back and it stays pending', async () => {
    const { id } = await approvedMerchant();
    await fund(id, 5_000n);
    const created = await ctx.http().post('/v1/ledger/adjustments').set(bearer(financeToken)).send({ merchant_id: id, direction: 'DEBIT', amount: '75.00', reason: 'Recover duplicate settlement amount', reference: 'RECON-77' });
    const res = await ctx.http().post(`/v1/ledger/adjustments/${created.body.data.id}/approve`).set(bearer(finance2Token)).send({});
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const after = await ctx.http().get(`/v1/ledger/adjustments/${created.body.data.id}`).set(bearer(financeToken));
    expect(after.body.data).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(await available(id)).toBe('50.00');
  });

  it('is never available to merchants', async () => {
    const { id, ownerToken } = await approvedMerchant();
    const res = await ctx.http().post('/v1/ledger/adjustments').set(bearer(ownerToken)).send({ merchant_id: id, direction: 'CREDIT', amount: '1000000.00', reason: 'Give myself money please', reference: 'X-1' });
    expect(res.status).toBe(403);
  });
});

describe('read access', () => {
  it('scopes balances, accounts and statements to the tenant', async () => {
    const a = await approvedMerchant();
    const b = await approvedMerchant();
    await fund(a.id, 12_345n);
    const own = await ctx.http().get(`/v1/ledger/balances?merchant_id=${a.id}`).set(bearer(a.ownerToken));
    expect(own.body.data.available).toBe('123.45');
    expect((await ctx.http().get(`/v1/ledger/balances?merchant_id=${a.id}`).set(bearer(b.ownerToken))).status).toBe(404);

    const accounts = await ctx.http().get('/v1/ledger/accounts?limit=100').set(bearer(a.ownerToken));
    expect((accounts.body.data as { owner_id: string }[]).every((x) => x.owner_id === a.id)).toBe(true);
    const availableAcct = (accounts.body.data as { id: string; bucket: string }[]).find((x) => x.bucket === 'AVAILABLE')!;
    const statement = await ctx.http().get(`/v1/ledger/accounts/${availableAcct.id}/entries`).set(bearer(a.ownerToken));
    expect(statement.body.data[0]).toMatchObject({ journal_type: 'SETTLEMENT', direction: 'CREDIT', amount: '123.45', balance_after: '123.45' });
    expect((await ctx.http().get(`/v1/ledger/accounts/${availableAcct.id}/entries`).set(bearer(b.ownerToken))).status).toBe(404);
    // Platform hot accounts are invisible to merchants.
    const fee = await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: Accounts.FEE_REVENUE } });
    expect((await ctx.http().get(`/v1/ledger/accounts/${fee.id}`).set(bearer(a.ownerToken))).status).toBe(404);
    expect((await ctx.http().get('/v1/ledger/summary').set(bearer(a.ownerToken))).status).toBe(403);
  });
});
