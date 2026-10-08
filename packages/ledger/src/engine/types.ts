/** Ledger domain types. Mirrors the Prisma enums (kept dependency-free so the engine stays pure). */

export type Direction = 'DEBIT' | 'CREDIT';
export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'EQUITY' | 'CLEARING';
export type OwnerType = 'PLATFORM' | 'MERCHANT' | 'RESELLER';
export type Bucket = 'AVAILABLE' | 'PENDING' | 'UNSETTLED' | 'SETTLED' | 'RESERVED' | 'LIEN' | 'RECEIVABLE' | 'COMMISSION_PAYABLE';

export const JOURNAL_TYPES = [
  'PAYIN_CAPTURE',
  'PROVIDER_SETTLEMENT',
  'SETTLEMENT',
  'SETTLEMENT_TRANSFER',
  'SETTLEMENT_PAID',
  'SETTLEMENT_RETURN',
  'HOLD_RELEASE',
  'REFUND',
  'REFUND_REVERSAL',
  'CHARGEBACK_LIEN',
  'CHARGEBACK_DEBIT',
  'CHARGEBACK_RELEASE',
  'PAYOUT_RESERVE',
  'PAYOUT_SETTLE',
  'PAYOUT_RELEASE',
  'PAYOUT_REVERSAL',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT',
  'LIEN_PLACE',
  'LIEN_RELEASE',
  'COMMISSION_ACCRUAL',
  'COMMISSION_PAYOUT',
  'PROVIDER_CHARGE',
  'REVERSAL',
  'FUND_LOAD',
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export type SourceType = 'PAYMENT' | 'PAYOUT' | 'REFUND' | 'SETTLEMENT' | 'CHARGEBACK' | 'ADJUSTMENT' | 'PROVIDER' | 'RISK' | 'JOURNAL' | 'SYSTEM' | 'FUND_REQUEST';

export interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: Direction;
  ownerType: OwnerType;
  ownerId: string | null;
  bucket: Bucket | null;
  currency: string;
  allowNegative: boolean;
  /** Maintained accounts keep a locked running balance; hot platform accounts don't. */
  maintained: boolean;
}

export interface PostingLine {
  accountCode: string;
  direction: Direction;
  /** Strictly positive minor units. */
  amountMinor: bigint;
  currency: string;
  memo?: string;
}

export interface PostJournalInput {
  type: JournalType;
  /** Deterministic: '<source>:<id>:<step>'. Posting the same key twice returns the first journal. */
  idempotencyKey: string;
  source: { type: SourceType; id: string };
  lines: PostingLine[];
  description?: string;
  effectiveAt?: Date;
  metadata?: Record<string, string>;
  reversesJournalId?: string;
  actor: { userId?: string | null; requestId?: string | null };
}

export interface PostedEntry {
  entryId: string;
  accountId: string;
  accountCode: string;
  direction: Direction;
  amountMinor: bigint;
  balanceAfterMinor: bigint | null;
}

export interface PostedJournal {
  journalId: string;
  replayed: boolean;
  entries: PostedEntry[];
}
