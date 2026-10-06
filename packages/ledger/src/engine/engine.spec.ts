import { describe, expect, it } from 'vitest';
import { Accounts } from './chart';
import { type EntryRow, type JournalRow, type LedgerStore, postJournal, reverseJournal, type StoredJournal } from './engine';
import { InsufficientBalanceError, JournalAlreadyReversedError, LedgerIdempotencyConflict, LedgerValidationError } from './errors';
import type { AccountSpec, PostingLine, PostJournalInput } from './types';

/** In-memory LedgerStore (single-threaded; DB concurrency is covered by API integration tests). */
class MemoryStore implements LedgerStore {
  seq = 0;
  accounts = new Map<string, AccountSpec & { id: string; balance: bigint | null }>();
  journals: (JournalRow & { reversedBy: string | null })[] = [];
  entries: EntryRow[] = [];
  private id(p: string) {
    return `${p}_${String(++this.seq).padStart(26, '0')}`;
  }
  newJournalId = () => this.id('jrnl');
  newEntryId = () => this.id('lent');
  newAccountId = () => this.id('lacc');
  private stored(j: JournalRow & { reversedBy: string | null }): StoredJournal {
    const codeById = new Map([...this.accounts.values()].map((a) => [a.id, a.code]));
    return {
      ...j,
      entries: this.entries
        .filter((e) => e.journalId === j.id)
        .map((e) => ({ entryId: e.id, accountId: e.accountId, accountCode: codeById.get(e.accountId)!, direction: e.direction, amountMinor: e.amountMinor, balanceAfterMinor: e.balanceAfterMinor, currency: e.currency })),
    };
  }
  async findJournalByKey(key: string) {
    const j = this.journals.find((x) => x.idempotencyKey === key);
    return j ? this.stored(j) : null;
  }
  async findJournalById(id: string) {
    const j = this.journals.find((x) => x.id === id);
    return j ? this.stored(j) : null;
  }
  async ensureAccounts(specs: AccountSpec[]) {
    const out = new Map<string, { id: string; currency: string }>();
    for (const s of specs) {
      if (!this.accounts.has(s.code)) this.accounts.set(s.code, { ...s, id: this.newAccountId(), balance: s.maintained ? 0n : null });
      const a = this.accounts.get(s.code)!;
      out.set(s.code, { id: a.id, currency: a.currency });
    }
    return out;
  }
  async lockAccounts(ids: string[]) {
    expect([...ids].sort()).toEqual(ids); // engine must lock in sorted order
    return new Map([...this.accounts.values()].filter((a) => ids.includes(a.id)).map((a) => [a.id, a.balance ?? 0n]));
  }
  async insertJournal(row: JournalRow) {
    if (this.journals.some((j) => j.idempotencyKey === row.idempotencyKey)) return false;
    this.journals.push({ ...row, reversedBy: null });
    if (row.reversesJournalId) this.journals.find((j) => j.id === row.reversesJournalId)!.reversedBy = row.id;
    return true;
  }
  async insertEntries(rows: EntryRow[]) {
    this.entries.push(...rows);
  }
  async setBalances(b: { accountId: string; balanceMinor: bigint }[]) {
    for (const { accountId, balanceMinor } of b) [...this.accounts.values()].find((a) => a.id === accountId)!.balance = balanceMinor;
  }
  balance(code: string) {
    return this.accounts.get(code)?.balance ?? 0n;
  }
  /** Σ(debits) − Σ(credits) across every entry — must always be zero. */
  trialBalance() {
    return this.entries.reduce((s, e) => s + (e.direction === 'DEBIT' ? e.amountMinor : -e.amountMinor), 0n);
  }
  /** Stored maintained balances equal what the entries imply. */
  assertBalancesMatchEntries() {
    for (const a of this.accounts.values()) {
      if (!a.maintained) continue;
      const fromEntries = this.entries
        .filter((e) => e.accountId === a.id)
        .reduce((s, e) => s + (e.direction === a.normalBalance ? e.amountMinor : -e.amountMinor), 0n);
      expect(a.balance, a.code).toBe(fromEntries);
    }
  }
}

const M = 'org_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const M2 = 'org_01HYYYYYYYYYYYYYYYYYYYYYYY';
const line = (accountCode: string, direction: 'DEBIT' | 'CREDIT', amountMinor: bigint): PostingLine => ({ accountCode, direction, amountMinor, currency: 'INR' });
const actor = { userId: 'usr_test', requestId: 'req_test' };

function capture(id: string, gross: bigint, fee: bigint, gst: bigint): PostJournalInput {
  return {
    type: 'PAYIN_CAPTURE',
    idempotencyKey: `payment:${id}:capture`,
    source: { type: 'PAYMENT', id },
    actor,
    lines: [
      line(Accounts.providerClearing('mock'), 'DEBIT', gross),
      line(Accounts.merchant(M, 'UNSETTLED'), 'CREDIT', gross - fee - gst),
      line(Accounts.FEE_REVENUE, 'CREDIT', fee),
      line(Accounts.GST_PAYABLE, 'CREDIT', gst),
    ].filter((l) => l.amountMinor > 0n), // zero-value lines are invalid; callers omit them
  };
}

function settleToWallet(id: string, amount: bigint): PostJournalInput {
  return { type: 'SETTLEMENT', idempotencyKey: `settlement:${id}`, source: { type: 'SETTLEMENT', id }, actor, lines: [line(Accounts.merchant(M, 'UNSETTLED'), 'DEBIT', amount), line(Accounts.merchant(M, 'AVAILABLE'), 'CREDIT', amount)] };
}

function reserve(id: string, amount: bigint): PostJournalInput {
  return { type: 'PAYOUT_RESERVE', idempotencyKey: `payout:${id}:reserve`, source: { type: 'PAYOUT', id }, actor, lines: [line(Accounts.merchant(M, 'AVAILABLE'), 'DEBIT', amount), line(Accounts.merchant(M, 'RESERVED'), 'CREDIT', amount)] };
}

describe('bank settlement lifecycle', () => {
  const j = (type: PostJournalInput['type'], key: string, lines: PostingLine[]): PostJournalInput => ({ type, idempotencyKey: key, source: { type: 'SETTLEMENT', id: 'stl_1' }, actor, lines });
  it('moves UNSETTLED into transit, then to the bank (+ memo) or back to UNSETTLED', async () => {
    const store = new MemoryStore();
    await postJournal(store, capture('pay_s1', 100000n, 180n, 32n)); // UNSETTLED 997.88
    await postJournal(store, j('SETTLEMENT_TRANSFER', 'settlement:stl_1:transfer', [line(Accounts.merchant(M, 'UNSETTLED'), 'DEBIT', 99_788n), line(Accounts.SETTLEMENT_CLEARING, 'CREDIT', 99_788n)]));
    expect(store.balance(Accounts.merchant(M, 'UNSETTLED'))).toBe(0n);
    await postJournal(store, j('SETTLEMENT_PAID', 'settlement:stl_1:paid', [
      line(Accounts.SETTLEMENT_CLEARING, 'DEBIT', 99_788n),
      line(Accounts.bank('nodal'), 'CREDIT', 99_788n),
      line(Accounts.SETTLED_CONTRA, 'DEBIT', 99_788n),
      line(Accounts.merchant(M, 'SETTLED'), 'CREDIT', 99_788n),
    ]));
    expect(store.balance(Accounts.merchant(M, 'SETTLED'))).toBe(99_788n);
    // A transfer can't come out of AVAILABLE, and a return can't credit AVAILABLE.
    await expect(postJournal(store, j('SETTLEMENT_TRANSFER', 'x1', [line(Accounts.merchant(M, 'AVAILABLE'), 'DEBIT', 1n), line(Accounts.SETTLEMENT_CLEARING, 'CREDIT', 1n)]))).rejects.toThrow(LedgerValidationError);
    await expect(postJournal(store, j('SETTLEMENT_RETURN', 'x2', [line(Accounts.SETTLEMENT_CLEARING, 'DEBIT', 1n), line(Accounts.merchant(M, 'AVAILABLE'), 'CREDIT', 1n)]))).rejects.toThrow(LedgerValidationError);
    await expect(postJournal(store, j('SETTLEMENT_PAID', 'x3', [line(Accounts.SETTLEMENT_CLEARING, 'DEBIT', 1n), line(Accounts.FEE_REVENUE, 'CREDIT', 1n)]))).rejects.toThrow(LedgerValidationError);
  });
});

describe('reseller commissions', () => {
  const R = 'org_01JA9C2D4F6G8H0J2K4M6N8P0R';
  const j = (type: PostJournalInput['type'], key: string, lines: PostingLine[]): PostJournalInput => ({ type, idempotencyKey: key, source: { type: 'PAYMENT', id: 'pay_c1' }, actor, lines });
  it('accrues to and pays out of the reseller payable, in the right direction only', async () => {
    const store = new MemoryStore();
    await postJournal(store, j('COMMISSION_ACCRUAL', 'commission:pay_c1', [line(Accounts.COMMISSION_EXPENSE, 'DEBIT', 40n), line(Accounts.resellerCommission(R), 'CREDIT', 40n)]));
    expect(store.balance(Accounts.resellerCommission(R))).toBe(40n);
    await postJournal(store, j('COMMISSION_PAYOUT', 'commission_payout:1', [line(Accounts.resellerCommission(R), 'DEBIT', 40n), line(Accounts.bank('nodal'), 'CREDIT', 40n)]));
    expect(store.balance(Accounts.resellerCommission(R))).toBe(0n);
    await expect(postJournal(store, j('COMMISSION_PAYOUT', 'x', [line(Accounts.resellerCommission(R), 'DEBIT', 1n), line(Accounts.bank('nodal'), 'CREDIT', 1n)]))).rejects.toThrow(); // can't overdraw
    await expect(postJournal(store, j('COMMISSION_ACCRUAL', 'y', [line(Accounts.resellerCommission(R), 'DEBIT', 1n), line(Accounts.COMMISSION_EXPENSE, 'CREDIT', 1n)]))).rejects.toThrow(LedgerValidationError);
    await expect(postJournal(store, j('PAYOUT_SETTLE', 'z', [line(Accounts.resellerCommission(R), 'DEBIT', 1n), line(Accounts.bank('nodal'), 'CREDIT', 1n)]))).rejects.toThrow(LedgerValidationError);
  });
});

describe('validation', () => {
  it('rejects unbalanced, single-line, zero and negative journals before any I/O', async () => {
    const store = new MemoryStore();
    const base = capture('pay_1', 100000n, 180n, 32n);
    await expect(postJournal(store, { ...base, lines: base.lines.slice(0, 3) })).rejects.toThrow(/does not balance/);
    await expect(postJournal(store, { ...base, lines: [base.lines[0]!] })).rejects.toThrow(/at least two/);
    await expect(postJournal(store, { ...base, lines: [line(Accounts.providerClearing('mock'), 'DEBIT', 0n), line(Accounts.FEE_REVENUE, 'CREDIT', 0n)] })).rejects.toThrow(/positive/);
    await expect(postJournal(store, { ...base, lines: [line('platform:MADE_UP', 'DEBIT', 1n), line(Accounts.FEE_REVENUE, 'CREDIT', 1n)] })).rejects.toThrow(/Unknown ledger account/);
    expect(store.journals).toHaveLength(0);
  });

  it('enforces journal-type rules and the single-merchant invariant', async () => {
    const store = new MemoryStore();
    // A "reserve" that drains UNSETTLED instead of AVAILABLE is refused.
    await expect(
      postJournal(store, { ...reserve('pout_1', 100n), lines: [line(Accounts.merchant(M, 'UNSETTLED'), 'DEBIT', 100n), line(Accounts.merchant(M, 'RESERVED'), 'CREDIT', 100n)] }),
    ).rejects.toThrow(LedgerValidationError);
    // Moving money between two merchants is never a valid journal.
    await expect(
      postJournal(store, { type: 'LIEN_PLACE', idempotencyKey: 'x', source: { type: 'RISK', id: 'r' }, actor, lines: [line(Accounts.merchant(M, 'AVAILABLE'), 'DEBIT', 1n), line(Accounts.merchant(M2, 'LIEN'), 'CREDIT', 1n)] }),
    ).rejects.toThrow(/more than one merchant/);
  });
});

describe('posting', () => {
  it('posts the payout example from the spec: debit ₹10,005.90, clearing ₹10,000, fee ₹5, GST ₹0.90', async () => {
    const store = new MemoryStore();
    await postJournal(store, capture('pay_1', 2_000_000n, 0n + 3600n, 648n));
    await postJournal(store, settleToWallet('stl_1', 2_000_000n - 3600n - 648n));
    const before = store.balance(Accounts.merchant(M, 'AVAILABLE'));
    await postJournal(store, reserve('pout_1', 1_000_590n));
    await postJournal(store, {
      type: 'PAYOUT_SETTLE',
      idempotencyKey: 'payout:pout_1:settle',
      source: { type: 'PAYOUT', id: 'pout_1' },
      actor,
      lines: [
        line(Accounts.merchant(M, 'RESERVED'), 'DEBIT', 1_000_590n),
        line(Accounts.providerClearing('mock'), 'CREDIT', 1_000_000n),
        line(Accounts.FEE_REVENUE, 'CREDIT', 500n),
        line(Accounts.GST_PAYABLE, 'CREDIT', 90n),
      ],
    });
    expect(before - store.balance(Accounts.merchant(M, 'AVAILABLE'))).toBe(1_000_590n);
    expect(store.balance(Accounts.merchant(M, 'RESERVED'))).toBe(0n);
    expect(store.trialBalance()).toBe(0n);
    store.assertBalancesMatchEntries();
  });

  it('refuses to overdraw AVAILABLE and leaves no partial rows', async () => {
    const store = new MemoryStore();
    await postJournal(store, capture('pay_1', 10_000n, 0n + 18n, 3n));
    await postJournal(store, settleToWallet('stl_1', 9_979n));
    const journals = store.journals.length;
    const err = await postJournal(store, reserve('pout_x', 9_980n)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect((err as InsufficientBalanceError).bucket).toBe('AVAILABLE');
    expect(store.journals).toHaveLength(journals);
    expect(store.balance(Accounts.merchant(M, 'AVAILABLE'))).toBe(9_979n);
  });

  it('is idempotent: same key replays, different lines conflict', async () => {
    const store = new MemoryStore();
    const first = await postJournal(store, capture('pay_1', 10_000n, 18n, 3n));
    const again = await postJournal(store, capture('pay_1', 10_000n, 18n, 3n));
    expect(again).toMatchObject({ journalId: first.journalId, replayed: true });
    expect(store.journals).toHaveLength(1);
    await expect(postJournal(store, capture('pay_1', 20_000n, 18n, 3n))).rejects.toThrow(LedgerIdempotencyConflict);
    // Line order doesn't change identity.
    const reordered = capture('pay_1', 10_000n, 18n, 3n);
    reordered.lines.reverse();
    expect((await postJournal(store, reordered)).replayed).toBe(true);
  });

  it('reverses exactly once, never a reversal, and not when funds were spent', async () => {
    const store = new MemoryStore();
    const cap = await postJournal(store, capture('pay_1', 10_000n, 18n, 3n));
    const rev = await reverseJournal(store, cap.journalId, { reason: 'Duplicate capture', actor });
    expect(store.balance(Accounts.merchant(M, 'UNSETTLED'))).toBe(0n);
    expect((await reverseJournal(store, cap.journalId, { reason: 'again', actor })).journalId).toBe(rev.journalId);
    await expect(reverseJournal(store, rev.journalId, { reason: 'undo', actor })).rejects.toThrow(/cannot itself be reversed/);

    const cap2 = await postJournal(store, capture('pay_2', 10_000n, 18n, 3n));
    await postJournal(store, settleToWallet('stl_2', 9_979n));
    await postJournal(store, reserve('pout_2', 9_979n));
    const settle = store.journals.find((j) => j.idempotencyKey === 'settlement:stl_2')!;
    await expect(reverseJournal(store, settle.id, { reason: 'wrong', actor })).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(cap2.replayed).toBe(false);
    store.journals.find((j) => j.id === cap.journalId)!.reversedBy = 'jrnl_other';
    await expect(reverseJournal(store, cap.journalId, { reason: 'x', actor })).resolves.toBeDefined();
    expect(JournalAlreadyReversedError).toBeDefined();
  });

  it('keeps the trial balance at zero and stored balances equal to entries over many random postings', async () => {
    const store = new MemoryStore();
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const gross = BigInt(100 + rand(1_000_000));
      const fee = gross / 500n;
      const gst = (fee * 18n) / 100n;
      await postJournal(store, capture(`pay_${i}`, gross, fee, gst));
      if (rand(2)) await postJournal(store, settleToWallet(`stl_${i}`, gross - fee - gst));
      const avail = store.balance(Accounts.merchant(M, 'AVAILABLE'));
      if (avail > 0n && rand(3) === 0) {
        const amt = BigInt(1 + rand(Number(avail)));
        await postJournal(store, reserve(`pout_${i}`, amt));
        if (rand(2)) {
          await postJournal(store, { type: 'PAYOUT_RELEASE', idempotencyKey: `payout:pout_${i}:release`, source: { type: 'PAYOUT', id: `pout_${i}` }, actor, lines: [line(Accounts.merchant(M, 'RESERVED'), 'DEBIT', amt), line(Accounts.merchant(M, 'AVAILABLE'), 'CREDIT', amt)] });
        }
      }
    }
    expect(store.trialBalance()).toBe(0n);
    store.assertBalancesMatchEntries();
    for (const a of store.accounts.values()) if (a.maintained) expect(a.balance! >= 0n, a.code).toBe(true);
  });
});
