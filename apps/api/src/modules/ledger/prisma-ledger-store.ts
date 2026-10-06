import { newId } from '@pay2all/auth';
import type { Prisma, TransactionClient } from '@pay2all/database';
import type { AccountSpec, EntryRow, JournalRow, LedgerStore, StoredJournal } from '@pay2all/ledger/engine';

/**
 * LedgerStore backed by Prisma. Every method runs on the caller's transaction client; locking uses
 * raw SQL because Prisma has no row-lock API (ADR-11).
 */
export class PrismaLedgerStore implements LedgerStore {
  constructor(private readonly tx: TransactionClient) {}

  newJournalId = () => newId('journal');
  newEntryId = () => newId('ledgerEntry');
  newAccountId = () => newId('ledgerAccount');

  private async load(where: Prisma.LedgerJournalWhereUniqueInput): Promise<StoredJournal | null> {
    const j = await this.tx.ledgerJournal.findUnique({
      where,
      include: { entries: { orderBy: { id: 'asc' }, include: { account: { select: { code: true } } } } },
    });
    if (!j) return null;
    const reversal = await this.tx.ledgerJournal.findUnique({ where: { reversesJournalId: j.id }, select: { id: true } });
    return {
      id: j.id,
      type: j.type,
      linesHash: j.linesHash,
      sourceType: j.sourceType,
      sourceId: j.sourceId,
      reversesJournalId: j.reversesJournalId,
      reversedBy: reversal?.id ?? null,
      entries: j.entries.map((e) => ({
        entryId: e.id,
        accountId: e.accountId,
        accountCode: e.account.code,
        direction: e.direction,
        amountMinor: e.amountMinor,
        balanceAfterMinor: e.balanceAfterMinor,
        currency: e.currency,
      })),
    };
  }

  findJournalByKey(idempotencyKey: string) {
    return this.load({ idempotencyKey });
  }

  findJournalById(id: string) {
    return this.load({ id });
  }

  async ensureAccounts(specs: AccountSpec[]) {
    const codes = specs.map((s) => s.code);
    const existing = await this.tx.ledgerAccount.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, currency: true } });
    const missing = specs.filter((s) => !existing.some((e) => e.code === s.code));
    if (missing.length) {
      // ON CONFLICT (code) DO NOTHING — concurrent first postings for a merchant both succeed.
      await this.tx.ledgerAccount.createMany({
        data: missing.map((s) => ({
          id: this.newAccountId(),
          code: s.code,
          name: s.name,
          type: s.type,
          normalBalance: s.normalBalance,
          ownerType: s.ownerType,
          ownerId: s.ownerId,
          bucket: s.bucket,
          currency: s.currency,
          allowNegative: s.allowNegative,
          balanceMinor: s.maintained ? 0n : null,
        })),
        skipDuplicates: true,
      });
    }
    const all = missing.length ? await this.tx.ledgerAccount.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, currency: true } }) : existing;
    return new Map(all.map((a) => [a.code, { id: a.id, currency: a.currency }]));
  }

  async lockAccounts(accountIds: string[]) {
    if (accountIds.length === 0) return new Map<string, bigint>();
    const rows = await this.tx.$queryRaw<{ id: string; balance_minor: bigint }[]>`
      SELECT id, balance_minor FROM ledger_accounts WHERE id = ANY(${accountIds}::text[]) ORDER BY id FOR UPDATE`;
    return new Map(rows.map((r) => [r.id, BigInt(r.balance_minor)]));
  }

  async insertJournal(row: JournalRow) {
    const result = await this.tx.ledgerJournal.createMany({ data: [row], skipDuplicates: true });
    return result.count === 1;
  }

  async insertEntries(rows: EntryRow[]) {
    await this.tx.ledgerEntry.createMany({ data: rows });
  }

  async setBalances(balances: { accountId: string; balanceMinor: bigint }[]) {
    for (const b of balances) {
      await this.tx.ledgerAccount.update({ where: { id: b.accountId }, data: { balanceMinor: b.balanceMinor, version: { increment: 1 } } });
    }
  }
}
