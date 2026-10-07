import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient, TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { type PostedJournal, postJournal, type PostJournalInput, reverseJournal } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { MerchantAccessService } from '../merchants/merchant-access.service';
import { mapLedgerError } from './ledger.errors';
import { JOURNAL_INCLUDE, major, presentAccount, presentJournal } from './ledger.presenter';
import { PrismaLedgerStore } from './prisma-ledger-store';
import { runLedgerTransaction } from './ledger-transaction';

export const MERCHANT_BUCKETS = ['AVAILABLE', 'PENDING', 'UNSETTLED', 'RESERVED', 'LIEN', 'SETTLED', 'RECEIVABLE'] as const;

export interface DriftRow {
  account_id: string;
  code: string;
  owner_id: string | null;
  stored_minor: bigint | null;
  computed_minor: string;
  last_balance_after_minor: bigint | null;
}

/**
 * Ledger application service. Other modules post through `post()` *inside their own transaction*
 * (ADR-5); this service never opens a transaction around someone else's business change.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly merchants: MerchantAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Post a journal on the caller's transaction. Errors are mapped to API errors. */
  async post(tx: TransactionClient, input: Omit<PostJournalInput, 'actor'> & { actor?: PostJournalInput['actor'] }): Promise<PostedJournal> {
    const ctx = RequestContextStore.get();
    try {
      return await postJournal(new PrismaLedgerStore(tx), { ...input, actor: input.actor ?? { userId: ctx?.actor?.userId ?? null, requestId: ctx?.requestId ?? null } });
    } catch (err) {
      throw mapLedgerError(err);
    }
  }

  /** Run a money-moving unit of work with locking discipline and safe retries. */
  run<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return runLedgerTransaction(this.prisma, work);
  }

  async reverse(actor: Actor, journalId: string, reason: string) {
    const exists = await this.prisma.ledgerJournal.findUnique({ where: { id: journalId }, select: { id: true } });
    if (!exists) throw new AppError(ErrorCode.NOT_FOUND, 'Journal not found');
    const result = await this.run(async (tx) => {
      let posted: PostedJournal;
      try {
        posted = await reverseJournal(new PrismaLedgerStore(tx), journalId, { reason, actor: { userId: actor.userId, requestId: RequestContextStore.get()?.requestId ?? null } });
      } catch (err) {
        throw mapLedgerError(err);
      }
      if (!posted.replayed) {
        await this.audit.record({ action: 'ledger.journal.reversed', resourceType: 'ledger_journal', resourceId: journalId, organizationId: null, newValue: { reversal_journal_id: posted.journalId }, metadata: { reason } }, tx);
        await this.outbox.add(tx, { eventType: 'ledger.journal_reversed', aggregateType: 'ledger_journal', aggregateId: journalId, payload: { journal_id: journalId, reversal_journal_id: posted.journalId } });
      }
      return posted;
    });
    return this.getJournal(actor, result.journalId);
  }

  // ---- Balances --------------------------------------------------------------------------------

  /** Merchant balance buckets from the maintained running balances (no locks; read-only). */
  async merchantBalances(merchantId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { ownerType: 'MERCHANT', ownerId: merchantId }, select: { bucket: true, balanceMinor: true, currency: true } });
    const byBucket = new Map(accounts.map((a) => [a.bucket, a.balanceMinor ?? 0n]));
    const value = (b: (typeof MERCHANT_BUCKETS)[number]) => byBucket.get(b) ?? 0n;
    return {
      merchant_id: merchantId,
      currency: 'INR',
      available: minorToMajorString(value('AVAILABLE')),
      pending: minorToMajorString(value('PENDING')),
      unsettled: minorToMajorString(value('UNSETTLED')),
      reserved: minorToMajorString(value('RESERVED')),
      lien: minorToMajorString(value('LIEN')),
      settled_to_date: minorToMajorString(value('SETTLED')),
      receivable: minorToMajorString(value('RECEIVABLE')),
      as_of: new Date(),
    };
  }

  async balancesFor(actor: Actor, requested: string | undefined) {
    const merchantId = requested ?? (actor.organizationType === 'MERCHANT' ? actor.organizationId : undefined);
    if (!merchantId) throw new AppError(ErrorCode.INVALID_REQUEST, 'merchant_id is required');
    await this.merchants.require(actor, merchantId);
    return this.merchantBalances(merchantId);
  }

  /** Platform totals for the admin dashboard. */
  async platformSummary() {
    const rows = await this.prisma.ledgerAccount.groupBy({ by: ['bucket'], where: { ownerType: 'MERCHANT' }, _sum: { balanceMinor: true } });
    const sum = (b: string) => rows.find((r) => r.bucket === b)?._sum.balanceMinor ?? 0n;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const journals24h = await this.prisma.ledgerJournal.count({ where: { postedAt: { gte: since } } });
    return {
      currency: 'INR',
      total_merchant_balance: minorToMajorString(sum('AVAILABLE') + sum('UNSETTLED') + sum('PENDING') + sum('RESERVED') + sum('LIEN')),
      available: minorToMajorString(sum('AVAILABLE')),
      unsettled: minorToMajorString(sum('UNSETTLED')),
      pending: minorToMajorString(sum('PENDING')),
      reserved: minorToMajorString(sum('RESERVED')),
      lien: minorToMajorString(sum('LIEN')),
      journals_last_24h: journals24h,
    };
  }

  // ---- Integrity -------------------------------------------------------------------------------

  async trialBalance() {
    const [row] = await this.prisma.$queryRaw<{ debits: string | null; credits: string | null; entries: bigint; journals: bigint }[]>`
      SELECT SUM(amount_minor) FILTER (WHERE direction = 'DEBIT')::text AS debits,
             SUM(amount_minor) FILTER (WHERE direction = 'CREDIT')::text AS credits,
             COUNT(*) AS entries,
             COUNT(DISTINCT journal_id) AS journals
        FROM ledger_entries`;
    const debits = BigInt(row?.debits ?? '0');
    const credits = BigInt(row?.credits ?? '0');
    return { debits: minorToMajorString(debits), credits: minorToMajorString(credits), difference: minorToMajorString(debits - credits), balanced: debits === credits, entries: Number(row?.entries ?? 0), journals: Number(row?.journals ?? 0) };
  }

  /**
   * Compare every maintained balance with its entries (docs/LEDGER.md §5). Drift never gets
   * "fixed" automatically: it is reported, audited, and the merchant's payouts are frozen.
   */
  async verify(actor?: Actor) {
    const drift = await this.prisma.$queryRaw<DriftRow[]>`SELECT account_id, code, owner_id, stored_minor, computed_minor::text, last_balance_after_minor FROM ledger_verify_balances()`;
    const merchantIds = [...new Set(drift.filter((d) => d.code.startsWith('merchant:') && d.owner_id).map((d) => d.owner_id!))];
    if (drift.length) {
      this.logger.error({ drift: drift.map((d) => d.code) }, 'Ledger balance drift detected');
      await this.prisma.$transaction(async (tx) => {
        if (merchantIds.length) await tx.merchant.updateMany({ where: { id: { in: merchantIds } }, data: { payoutEnabled: false } });
        await this.audit.record(
          { action: 'ledger.drift_detected', resourceType: 'ledger', resourceId: null, organizationId: null, actor: actor ? undefined : { type: 'SYSTEM', id: null }, metadata: { accounts: drift.map((d) => d.code), payouts_frozen_for: merchantIds, severity: 'CRITICAL' } },
          tx,
        );
        await this.outbox.add(tx, { eventType: 'ledger.drift_detected', aggregateType: 'ledger', aggregateId: 'ledger', payload: { accounts: drift.map((d) => d.code), merchant_ids: merchantIds } });
      });
    }
    return {
      ok: drift.length === 0,
      checked_at: new Date(),
      drift: drift.map((d) => ({ account_id: d.account_id, code: d.code, stored: major(d.stored_minor), computed: minorToMajorString(BigInt(d.computed_minor)), last_balance_after: major(d.last_balance_after_minor) })),
      payouts_frozen_for: merchantIds,
      trial_balance: await this.trialBalance(),
    };
  }

  // ---- Read models -----------------------------------------------------------------------------

  /** Owner ids visible to the actor (null = everything, platform staff). */
  private async visibleOwners(actor: Actor): Promise<string[] | null> {
    return this.scope.accessibleOrganizationIds(actor);
  }

  async listAccounts(actor: Actor, q: { owner_type?: string; owner_id?: string; bucket?: string; search?: string; cursor?: string; limit: number }) {
    const owners = await this.visibleOwners(actor);
    if (q.owner_id && owners && !owners.includes(q.owner_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Owner not found');
    const rows = await this.prisma.ledgerAccount.findMany({
      where: {
        AND: [
          owners ? { ownerId: { in: owners } } : {},
          q.owner_type ? { ownerType: q.owner_type as never } : {},
          q.owner_id ? { ownerId: q.owner_id } : {},
          q.bucket ? { bucket: q.bucket as never } : {},
          q.search ? { code: { contains: q.search } } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentAccount);
  }

  private async requireAccount(actor: Actor, accountId: string) {
    const owners = await this.visibleOwners(actor);
    const account = await this.prisma.ledgerAccount.findFirst({ where: { id: accountId, ...(owners ? { ownerId: { in: owners } } : {}) } });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND, 'Account not found');
    return account;
  }

  async getAccount(actor: Actor, accountId: string) {
    return presentAccount(await this.requireAccount(actor, accountId));
  }

  /** Account statement: entries newest first with running balance (keyset paginated). */
  async statement(actor: Actor, accountId: string, q: { cursor?: string; limit: number; from?: string; to?: string }) {
    await this.requireAccount(actor, accountId);
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        AND: [
          { accountId },
          q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { journal: { select: { id: true, type: true, sourceType: true, sourceId: true, description: true, reversesJournalId: true } } },
    });
    return toPage(rows, q.limit, (e) => ({
      id: e.id,
      journal_id: e.journalId,
      journal_type: e.journal.type,
      source_type: e.journal.sourceType,
      source_id: e.journal.sourceId,
      description: e.journal.description,
      direction: e.direction,
      amount: minorToMajorString(e.amountMinor),
      currency: e.currency,
      balance_after: major(e.balanceAfterMinor),
      memo: e.memo,
      created_at: e.createdAt,
    }));
  }

  async listJournals(actor: Actor, q: { type?: string; source_type?: string; source_id?: string; merchant_id?: string; cursor?: string; limit: number }) {
    const owners = await this.visibleOwners(actor);
    if (q.merchant_id) await this.merchants.require(actor, q.merchant_id);
    const ownerFilter = q.merchant_id ? [q.merchant_id] : owners;
    const where: Prisma.LedgerJournalWhereInput = {
      AND: [
        ownerFilter ? { entries: { some: { account: { ownerId: { in: ownerFilter } } } } } : {},
        q.type ? { type: q.type as never } : {},
        q.source_type ? { sourceType: q.source_type as never } : {},
        q.source_id ? { sourceId: q.source_id } : {},
        // Journal ordering uses postedAt; reuse the keyset helper over (postedAt,id).
        q.cursor ? (() => { const c = decodeCursor(q.cursor); return c ? { OR: [{ postedAt: { lt: c.createdAt } }, { postedAt: c.createdAt, id: { lt: c.id } }] } : {}; })() : {},
      ],
    };
    const rows = await this.prisma.ledgerJournal.findMany({ where, orderBy: [{ postedAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, include: JOURNAL_INCLUDE });
    const visible = owners ? new Set(owners) : null;
    return toPage(rows.map((r) => ({ ...r, createdAt: r.postedAt })), q.limit, (j) => presentJournal(j, { visibleOwnerIds: visible }));
  }

  async getJournal(actor: Actor, journalId: string) {
    const owners = await this.visibleOwners(actor);
    const j = await this.prisma.ledgerJournal.findFirst({
      where: { id: journalId, ...(owners ? { entries: { some: { account: { ownerId: { in: owners } } } } } : {}) },
      include: JOURNAL_INCLUDE,
    });
    if (!j) throw new AppError(ErrorCode.NOT_FOUND, 'Journal not found');
    const reversal = await this.prisma.ledgerJournal.findUnique({ where: { reversesJournalId: j.id }, select: { id: true } });
    return presentJournal(j, { reversedBy: reversal?.id ?? null, visibleOwnerIds: owners ? new Set(owners) : null });
  }
}
