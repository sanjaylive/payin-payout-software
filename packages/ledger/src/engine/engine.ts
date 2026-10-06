import { createHash } from 'node:crypto';
import { MAX_MINOR } from '../money';
import { accountSpec } from './chart';
import { InsufficientBalanceError, JournalAlreadyReversedError, LedgerIdempotencyConflict, LedgerValidationError } from './errors';
import { assertJournalRules } from './rules';
import type { AccountSpec, Direction, JournalType, PostedEntry, PostedJournal, PostingLine, PostJournalInput, SourceType } from './types';

/**
 * Storage port for the posting engine. Implementations MUST run every call on the caller's
 * transaction (the engine never commits — ADR-5) and lock with SELECT … FOR UPDATE.
 */
export interface LedgerStore {
  newJournalId(): string;
  newEntryId(): string;
  newAccountId(): string;
  findJournalByKey(idempotencyKey: string): Promise<StoredJournal | null>;
  findJournalById(journalId: string): Promise<StoredJournal | null>;
  /** Create missing accounts (idempotently) and return id/currency for every code. */
  ensureAccounts(specs: AccountSpec[]): Promise<Map<string, { id: string; currency: string }>>;
  /** Lock maintained accounts in ascending id order; returns their current balances. */
  lockAccounts(accountIds: string[]): Promise<Map<string, bigint>>;
  /** Insert the journal; returns false if the idempotency key already exists (lost a race). */
  insertJournal(row: JournalRow): Promise<boolean>;
  insertEntries(rows: EntryRow[]): Promise<void>;
  setBalances(balances: { accountId: string; balanceMinor: bigint }[]): Promise<void>;
}

export interface StoredJournal {
  id: string;
  type: JournalType;
  linesHash: string;
  sourceType: SourceType;
  sourceId: string;
  reversesJournalId: string | null;
  reversedBy: string | null;
  entries: (PostedEntry & { currency: string })[];
}

export interface JournalRow {
  id: string;
  type: JournalType;
  idempotencyKey: string;
  linesHash: string;
  sourceType: SourceType;
  sourceId: string;
  reversesJournalId: string | null;
  description: string | null;
  metadata: Record<string, string>;
  effectiveAt: Date;
  createdById: string | null;
  requestId: string | null;
}

export interface EntryRow {
  id: string;
  journalId: string;
  accountId: string;
  direction: Direction;
  amountMinor: bigint;
  currency: string;
  balanceAfterMinor: bigint | null;
  memo: string | null;
}

/** Validate shape and balance before any I/O (step 1). */
export function validateJournal(input: PostJournalInput): Map<string, AccountSpec> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new LedgerValidationError('idempotencyKey is required (≤160 chars)');
  if (input.lines.length < 2) throw new LedgerValidationError('A journal needs at least two lines');
  const specs = new Map<string, AccountSpec>();
  const net = new Map<string, bigint>();
  for (const line of input.lines) {
    if (typeof line.amountMinor !== 'bigint' || line.amountMinor <= 0n) throw new LedgerValidationError('Line amounts must be positive bigint minor units');
    if (line.amountMinor > MAX_MINOR) throw new LedgerValidationError('Line amount exceeds the maximum');
    const spec = specs.get(line.accountCode) ?? accountSpec(line.accountCode, line.currency);
    if (spec.currency !== line.currency) throw new LedgerValidationError(`Mixed currencies on ${line.accountCode}`);
    specs.set(line.accountCode, spec);
    const signed = line.direction === 'DEBIT' ? line.amountMinor : -line.amountMinor;
    net.set(line.currency, (net.get(line.currency) ?? 0n) + signed);
  }
  for (const [currency, value] of net) {
    if (value !== 0n) throw new LedgerValidationError(`Journal does not balance in ${currency} (difference ${value})`);
  }
  assertJournalRules(input.type, input.lines, specs);
  return specs;
}

/** Canonical hash of what the journal *means*, independent of line order. */
export function linesHash(input: Pick<PostJournalInput, 'type' | 'source' | 'lines'>): string {
  const lines = input.lines
    .map((l) => `${l.accountCode}|${l.direction}|${l.amountMinor.toString()}|${l.currency}`)
    .sort();
  return createHash('sha256').update(JSON.stringify({ t: input.type, s: [input.source.type, input.source.id], l: lines })).digest('hex');
}

function signedDelta(spec: AccountSpec, line: PostingLine): bigint {
  return line.direction === spec.normalBalance ? line.amountMinor : -line.amountMinor;
}

/**
 * Post a balanced, idempotent journal inside the caller's transaction (docs/LEDGER.md §7):
 * validate → idempotency → resolve accounts → lock (sorted) → check non-negative → insert → update.
 */
export async function postJournal(store: LedgerStore, input: PostJournalInput): Promise<PostedJournal> {
  const specs = validateJournal(input);
  const hash = linesHash(input);

  const replay = async (): Promise<PostedJournal | null> => {
    const existing = await store.findJournalByKey(input.idempotencyKey);
    if (!existing) return null;
    if (existing.linesHash !== hash) throw new LedgerIdempotencyConflict(input.idempotencyKey);
    return { journalId: existing.id, replayed: true, entries: existing.entries };
  };

  const prior = await replay();
  if (prior) return prior;

  const accounts = await store.ensureAccounts([...specs.values()]);
  const maintainedIds = [...new Set([...specs.values()].filter((s) => s.maintained).map((s) => accounts.get(s.code)!.id))].sort();
  const balances = await store.lockAccounts(maintainedIds);

  // Compute running balances line by line (an account may appear more than once).
  const running = new Map(balances);
  const journalId = store.newJournalId();
  const entries: EntryRow[] = input.lines.map((line) => {
    const spec = specs.get(line.accountCode)!;
    const account = accounts.get(line.accountCode)!;
    let balanceAfter: bigint | null = null;
    if (spec.maintained) {
      balanceAfter = (running.get(account.id) ?? 0n) + signedDelta(spec, line);
      running.set(account.id, balanceAfter);
    }
    return { id: store.newEntryId(), journalId, accountId: account.id, direction: line.direction, amountMinor: line.amountMinor, currency: line.currency, balanceAfterMinor: balanceAfter, memo: line.memo ?? null };
  });

  // Non-negative check on final balances (step 5).
  for (const spec of specs.values()) {
    if (!spec.maintained || spec.allowNegative) continue;
    const id = accounts.get(spec.code)!.id;
    const final = running.get(id) ?? 0n;
    if (final < 0n) throw new InsufficientBalanceError(spec.code, spec.bucket, balances.get(id) ?? 0n, (balances.get(id) ?? 0n) - final);
  }

  const inserted = await store.insertJournal({
    id: journalId,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    linesHash: hash,
    sourceType: input.source.type,
    sourceId: input.source.id,
    reversesJournalId: input.reversesJournalId ?? null,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
    effectiveAt: input.effectiveAt ?? new Date(),
    createdById: input.actor.userId ?? null,
    requestId: input.actor.requestId ?? null,
  });
  if (!inserted) {
    // A concurrent transaction committed the same key first.
    const raced = await replay();
    if (raced) return raced;
    throw new LedgerValidationError('Journal insert was skipped but no journal exists for the key');
  }
  await store.insertEntries(entries);
  await store.setBalances(maintainedIds.map((id) => ({ accountId: id, balanceMinor: running.get(id)! })));

  return {
    journalId,
    replayed: false,
    entries: entries.map((e, i) => ({ entryId: e.id, accountId: e.accountId, accountCode: input.lines[i]!.accountCode, direction: e.direction, amountMinor: e.amountMinor, balanceAfterMinor: e.balanceAfterMinor })),
  };
}

/**
 * Post the exact mirror of a journal (type REVERSAL). A journal can be reversed once, reversals
 * themselves cannot be reversed, and the usual non-negative checks apply — reversing funds a
 * merchant has already spent fails loudly instead of driving a balance negative.
 */
export async function reverseJournal(
  store: LedgerStore,
  journalId: string,
  input: { reason: string; actor: PostJournalInput['actor'] },
): Promise<PostedJournal> {
  const original = await store.findJournalById(journalId);
  if (!original) throw new LedgerValidationError(`Journal ${journalId} not found`);
  if (original.type === 'REVERSAL') throw new LedgerValidationError('A reversal journal cannot itself be reversed');
  const idempotencyKey = `reversal:${journalId}`;
  if (original.reversedBy) {
    // Idempotent retry of the same reversal returns it; anything else is refused.
    const existing = await store.findJournalByKey(idempotencyKey);
    if (existing) return { journalId: existing.id, replayed: true, entries: existing.entries };
    throw new JournalAlreadyReversedError(journalId);
  }
  return postJournal(store, {
    type: 'REVERSAL',
    idempotencyKey,
    source: { type: 'JOURNAL', id: journalId },
    reversesJournalId: journalId,
    description: input.reason,
    metadata: { reason: input.reason, original_type: original.type },
    actor: input.actor,
    lines: original.entries.map((e) => ({
      accountCode: e.accountCode,
      direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amountMinor: e.amountMinor,
      currency: e.currency,
      memo: `Reversal of ${journalId}`,
    })),
  });
}
