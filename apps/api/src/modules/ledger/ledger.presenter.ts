import { minorToMajorString } from '@pay2all/ledger';
import type { Prisma } from '@pay2all/database';

export const major = (v: bigint | null | undefined) => (v === null || v === undefined ? null : minorToMajorString(v));

type Account = Prisma.LedgerAccountGetPayload<object>;
export function presentAccount(a: Account) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    normal_balance: a.normalBalance,
    owner_type: a.ownerType,
    owner_id: a.ownerId,
    bucket: a.bucket,
    currency: a.currency,
    allow_negative: a.allowNegative,
    maintained: a.balanceMinor !== null,
    balance: major(a.balanceMinor),
    created_at: a.createdAt,
  };
}

export const JOURNAL_INCLUDE = {
  entries: { orderBy: { id: 'asc' }, include: { account: { select: { code: true, name: true, bucket: true, ownerId: true } } } },
} satisfies Prisma.LedgerJournalInclude;
type Journal = Prisma.LedgerJournalGetPayload<{ include: typeof JOURNAL_INCLUDE }>;

export function presentJournal(j: Journal, opts: { reversedBy?: string | null; visibleOwnerIds?: Set<string> | null } = {}) {
  // Tenants see only their own lines of a journal (platform lines carry other merchants' context).
  const entries = opts.visibleOwnerIds ? j.entries.filter((e) => e.account.ownerId && opts.visibleOwnerIds!.has(e.account.ownerId)) : j.entries;
  return {
    id: j.id,
    type: j.type,
    idempotency_key: opts.visibleOwnerIds ? undefined : j.idempotencyKey,
    source_type: j.sourceType,
    source_id: j.sourceId,
    description: j.description,
    metadata: opts.visibleOwnerIds ? undefined : j.metadata,
    reverses_journal_id: j.reversesJournalId,
    reversed_by_journal_id: opts.reversedBy ?? null,
    effective_at: j.effectiveAt,
    posted_at: j.postedAt,
    created_by_id: opts.visibleOwnerIds ? undefined : j.createdById,
    request_id: j.requestId,
    entries: entries.map((e) => ({
      id: e.id,
      account_id: e.accountId,
      account_code: e.account.code,
      account_name: e.account.name,
      bucket: e.account.bucket,
      direction: e.direction,
      amount: minorToMajorString(e.amountMinor),
      currency: e.currency,
      balance_after: major(e.balanceAfterMinor),
      memo: e.memo,
    })),
  };
}
