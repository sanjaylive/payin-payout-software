import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, ReconciliationEntry, ReconciliationRun } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { listReconEntriesQuerySchema, resolveReconEntrySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { PaymentTransitionsService } from '../payments/payment-transitions.service';
import { compare, parseStatement, type StatementRow } from './recon-matcher';

export const RECON_MAX_BYTES = 10 * 1024 * 1024;
const major = (v: bigint | null) => (v === null ? null : minorToMajorString(v));

type EntryDraft = Omit<ReconciliationEntry, 'id' | 'runId' | 'createdAt' | 'resolutionNote' | 'resolvedById' | 'resolvedAt'>;

function presentRun(r: ReconciliationRun & { providerCode?: string }) {
  return {
    run_id: r.id,
    provider_id: r.providerId,
    provider: r.providerCode ?? null,
    kind: r.kind,
    file_name: r.fileName,
    status: r.status,
    period_from: r.periodFrom,
    period_to: r.periodTo,
    total_rows: r.totalRows,
    matched: r.matched,
    mismatched: r.mismatched,
    missing_internal: r.missingInternal,
    missing_provider: r.missingProvider,
    duplicates: r.duplicates,
    error: r.error,
    created_at: r.createdAt,
    completed_at: r.completedAt,
  };
}

function presentEntry(e: ReconciliationEntry) {
  return {
    entry_id: e.id,
    run_id: e.runId,
    line_no: e.lineNo,
    result: e.result,
    external_ref: e.externalRef,
    external_utr: e.externalUtr,
    external_amount: major(e.externalAmountMinor),
    external_status: e.externalStatus,
    internal_type: e.internalType,
    internal_id: e.internalId,
    internal_amount: major(e.internalAmountMinor),
    internal_status: e.internalStatus,
    resolution: e.resolution,
    resolution_note: e.resolutionNote,
    resolved_at: e.resolvedAt,
  };
}

/**
 * Provider reconciliation (docs/SETTLEMENT.md §5). Statements are stored (S3, SSE) and matched in
 * the jobs process. Matching never changes money: mismatches become entries for a person to
 * resolve, and the only money-moving resolution (accepting a provider-confirmed payment) goes
 * through the payment state machine and ledger like any other capture.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly payments: PaymentTransitionsService,
  ) {}

  async upload(actor: Actor, input: { provider_id: string; kind: 'PAYIN' | 'PAYOUT' }, file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    if (!file) throw new AppError(ErrorCode.INVALID_REQUEST, 'Attach the provider statement (CSV)');
    if (file.size > RECON_MAX_BYTES) throw new AppError(ErrorCode.INVALID_REQUEST, 'Statement is larger than 10 MB');
    if (file.buffer.includes(0)) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file is not a text CSV');
    const provider = await this.prisma.provider.findUnique({ where: { id: input.provider_id } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    const parsed = parseStatement(file.buffer.toString('utf8'));
    if (parsed.error) throw new AppError(ErrorCode.INVALID_REQUEST, parsed.error);
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    if (await this.prisma.reconciliationRun.findUnique({ where: { providerId_fileHash: { providerId: provider.id, fileHash: hash } } })) {
      throw new AppError(ErrorCode.CONFLICT, 'This exact statement was already imported for this provider');
    }
    const id = newId('reconRun');
    const key = `reconciliation/${provider.code}/${id}.csv`;
    await this.storage.put(key, file.buffer, 'text/csv', hash);
    const run = await this.prisma.reconciliationRun.create({ data: { id, providerId: provider.id, kind: input.kind, fileName: file.originalname.slice(0, 200), fileHash: hash, storageKey: key, createdById: actor.userId } });
    await this.audit.record({ action: 'reconciliation.run.created', resourceType: 'reconciliation_run', resourceId: id, organizationId: null, metadata: { provider: provider.code, kind: input.kind, rows: parsed.rows.length } });
    return presentRun({ ...run, providerCode: provider.code });
  }

  /** Jobs: process queued runs one at a time (SKIP LOCKED claim). */
  async processQueued(): Promise<number> {
    const run = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM reconciliation_runs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return null;
      return tx.reconciliationRun.update({ where: { id: rows[0].id }, data: { status: 'PROCESSING', startedAt: new Date() } });
    });
    if (!run) return 0;
    try {
      await this.match(run);
    } catch (err) {
      this.logger.error({ err, runId: run.id }, 'Reconciliation run failed');
      await this.prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) } });
    }
    return 1;
  }

  private async readStatement(key: string): Promise<string> {
    const stream = await this.storage.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  async match(run: ReconciliationRun): Promise<void> {
    const { rows } = parseStatement(await this.readStatement(run.storageKey));
    const dates = rows.map((r) => r.date).filter((d): d is Date => d !== null);
    const from = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
    const to = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime())) + 86_400_000) : null;
    const entries = run.kind === 'PAYIN' ? await this.matchPayins(run, rows, from, to) : await this.matchPayouts(run, rows, from, to);
    const count = (r: string) => entries.filter((e) => e.result === r).length;
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < entries.length; i += 1000) {
        await tx.reconciliationEntry.createMany({ data: entries.slice(i, i + 1000).map((e) => ({ ...e, id: newId('reconEntry'), runId: run.id })) });
      }
      await tx.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          periodFrom: from,
          periodTo: to,
          totalRows: rows.length,
          matched: count('MATCHED'),
          mismatched: count('AMOUNT_MISMATCH') + count('STATUS_MISMATCH'),
          missingInternal: count('MISSING_INTERNAL'),
          missingProvider: count('MISSING_PROVIDER'),
          duplicates: count('DUPLICATE'),
        },
      });
    });
  }

  private entry(row: StatementRow | null, result: EntryDraft['result'], internal: { type: string; id: string; amountMinor: bigint; status: string } | null): EntryDraft {
    return {
      lineNo: row?.lineNo ?? null,
      result,
      externalRef: row?.reference.slice(0, 120) ?? null,
      externalUtr: row?.utr?.slice(0, 40) ?? null,
      externalAmountMinor: row?.amountMinor ?? null,
      externalStatus: row?.rawStatus.slice(0, 30) ?? null,
      internalType: internal?.type ?? null,
      internalId: internal?.id ?? null,
      internalAmountMinor: internal?.amountMinor ?? null,
      internalStatus: internal?.status ?? null,
      resolution: result === 'MATCHED' ? 'NOT_REQUIRED' : 'OPEN',
    };
  }

  private async matchPayins(run: ReconciliationRun, rows: StatementRow[], from: Date | null, to: Date | null): Promise<EntryDraft[]> {
    const refs = rows.map((r) => r.reference).filter(Boolean);
    const txns = rows.map((r) => r.providerTxnId).filter((x): x is string => Boolean(x));
    const utrs = rows.map((r) => r.utr).filter((x): x is string => Boolean(x));
    const candidates = await this.prisma.payment.findMany({
      where: { providerId: run.providerId, OR: [{ id: { in: refs } }, { providerOrderId: { in: refs } }, { providerTransactionId: { in: txns } }, { utr: { in: utrs } }, { rrn: { in: utrs } }] },
      select: { id: true, providerOrderId: true, providerTransactionId: true, utr: true, rrn: true, amountMinor: true, status: true, captureJournalId: true, successAt: true },
    });
    const by = new Map<string, (typeof candidates)[number]>();
    for (const p of candidates) for (const k of [p.id, p.providerOrderId, p.providerTransactionId, p.utr, p.rrn]) if (k) by.set(k, p);
    const seen = new Set<string>();
    const out: EntryDraft[] = [];
    for (const row of rows) {
      if (row.error) {
        out.push(this.entry(row, 'MISSING_INTERNAL', null));
        continue;
      }
      // Match priority: provider transaction id → UTR/RRN → our reference (pay_ id / provider order id).
      const p = (row.providerTxnId && by.get(row.providerTxnId)) || (row.utr && by.get(row.utr)) || by.get(row.reference);
      if (!p) {
        out.push(this.entry(row, 'MISSING_INTERNAL', null));
        continue;
      }
      const internal = { type: 'PAYMENT', id: p.id, amountMinor: p.amountMinor, status: p.status };
      if (seen.has(p.id)) {
        out.push(this.entry(row, 'DUPLICATE', internal));
        continue;
      }
      seen.add(p.id);
      out.push(this.entry(row, compare(row, { amountMinor: p.amountMinor, succeeded: p.captureJournalId !== null }), internal));
    }
    // Our captures for this provider in the statement's period that the provider didn't report.
    if (from && to) {
      const missing = await this.prisma.payment.findMany({ where: { providerId: run.providerId, captureJournalId: { not: null }, successAt: { gte: from, lt: to }, id: { notIn: [...seen] } }, select: { id: true, amountMinor: true, status: true }, take: 10_000 });
      for (const p of missing) out.push(this.entry(null, 'MISSING_PROVIDER', { type: 'PAYMENT', id: p.id, amountMinor: p.amountMinor, status: p.status }));
    }
    return out;
  }

  private async matchPayouts(run: ReconciliationRun, rows: StatementRow[], from: Date | null, to: Date | null): Promise<EntryDraft[]> {
    const refs = rows.map((r) => r.reference).filter(Boolean);
    const utrs = rows.map((r) => r.utr).filter((x): x is string => Boolean(x));
    const attempts = await this.prisma.payoutAttempt.findMany({ where: { providerId: run.providerId, OR: [{ reference: { in: refs } }, { providerReference: { in: refs } }] }, select: { payoutId: true, reference: true, providerReference: true } });
    const payouts = await this.prisma.payout.findMany({
      where: { OR: [{ id: { in: [...attempts.map((a) => a.payoutId), ...refs] } }, { providerId: run.providerId, utr: { in: utrs } }] },
      select: { id: true, amountMinor: true, status: true, settleJournalId: true, reversalJournalId: true, utr: true, processedAt: true },
    });
    const byId = new Map(payouts.map((p) => [p.id, p]));
    const by = new Map<string, (typeof payouts)[number]>();
    for (const p of payouts) {
      by.set(p.id, p);
      if (p.utr) by.set(p.utr, p);
    }
    for (const a of attempts) {
      const p = byId.get(a.payoutId);
      if (!p) continue;
      by.set(a.reference, p);
      if (a.providerReference) by.set(a.providerReference, p);
    }
    const seen = new Set<string>();
    const out: EntryDraft[] = [];
    for (const row of rows) {
      const p = row.error ? undefined : (row.utr && by.get(row.utr)) || by.get(row.reference);
      if (!p) {
        out.push(this.entry(row, 'MISSING_INTERNAL', null));
        continue;
      }
      const internal = { type: 'PAYOUT', id: p.id, amountMinor: p.amountMinor, status: p.status };
      if (seen.has(p.id)) {
        out.push(this.entry(row, 'DUPLICATE', internal));
        continue;
      }
      seen.add(p.id);
      out.push(this.entry(row, compare(row, { amountMinor: p.amountMinor, succeeded: p.settleJournalId !== null, reversed: p.reversalJournalId !== null }), internal));
    }
    if (from && to) {
      const missing = await this.prisma.payout.findMany({ where: { providerId: run.providerId, settleJournalId: { not: null }, processedAt: { gte: from, lt: to }, id: { notIn: [...seen] } }, select: { id: true, amountMinor: true, status: true }, take: 10_000 });
      for (const p of missing) out.push(this.entry(null, 'MISSING_PROVIDER', { type: 'PAYOUT', id: p.id, amountMinor: p.amountMinor, status: p.status }));
    }
    return out;
  }

  // ---- Reads & resolution --------------------------------------------------------------------------

  async listRuns() {
    const runs = await this.prisma.reconciliationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const codes = new Map((await this.prisma.provider.findMany({ select: { id: true, code: true } })).map((p) => [p.id, p.code]));
    return runs.map((r) => presentRun({ ...r, providerCode: codes.get(r.providerId) }));
  }

  async getRun(id: string) {
    const r = await this.prisma.reconciliationRun.findUnique({ where: { id } });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, 'Run not found');
    const p = await this.prisma.provider.findUnique({ where: { id: r.providerId }, select: { code: true } });
    const open = await this.prisma.reconciliationEntry.count({ where: { runId: id, resolution: 'OPEN' } });
    return { ...presentRun({ ...r, providerCode: p?.code }), open_items: open };
  }

  async listEntries(runId: string, q: z.output<typeof listReconEntriesQuerySchema>) {
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.ReconciliationEntryWhereInput = {
      runId,
      ...(q.result ? { result: q.result } : {}),
      ...(q.resolution ? { resolution: q.resolution } : {}),
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
    };
    const rows = await this.prisma.reconciliationEntry.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: q.limit + 1 });
    return toPage(rows, q.limit, presentEntry);
  }

  async resolve(actor: Actor, entryId: string, input: z.output<typeof resolveReconEntrySchema>) {
    const e = await this.prisma.reconciliationEntry.findUnique({ where: { id: entryId } });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, 'Entry not found');
    if (e.resolution !== 'OPEN') throw new AppError(ErrorCode.CONFLICT, 'Entry is already resolved');
    let outcome: string | null = null;
    if (input.action === 'ACCEPT_PROVIDER_SUCCESS') {
      // The provider (statement) says the customer paid; we never captured. Capture now, through the
      // state machine — only for the exact amount we asked for.
      if (e.result !== 'STATUS_MISMATCH' || e.internalType !== 'PAYMENT' || !e.internalId) throw new AppError(ErrorCode.INVALID_REQUEST, 'Only a payment status mismatch can be accepted');
      if (!['success', 'successful', 'captured', 'paid', 'processed', 'completed', 'settled'].includes((e.externalStatus ?? '').toLowerCase())) throw new AppError(ErrorCode.INVALID_REQUEST, 'The provider did not report this payment as successful');
      if (e.externalAmountMinor !== e.internalAmountMinor) throw new AppError(ErrorCode.INVALID_REQUEST, 'Amounts differ; resolve through an adjustment instead');
      outcome = await this.payments.apply(e.internalId, { status: 'SUCCESS', amountMinor: e.externalAmountMinor ?? undefined, utr: e.externalUtr ?? undefined }, 'REVIEW', { forceLateAccept: true });
      if (outcome !== 'APPLIED' && outcome !== 'DUPLICATE') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Payment could not be captured (${outcome})`);
    }
    const res = await this.prisma.reconciliationEntry.updateMany({ where: { id: entryId, resolution: 'OPEN' }, data: { resolution: 'RESOLVED', resolutionNote: input.note, resolvedById: actor.userId, resolvedAt: new Date() } });
    if (res.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Entry is already resolved');
    await this.audit.record({ action: 'reconciliation.entry.resolved', resourceType: 'reconciliation_entry', resourceId: entryId, organizationId: null, metadata: { action: input.action, result: e.result, internal_id: e.internalId, outcome, note: input.note, severity: input.action === 'NOTE' ? 'MEDIUM' : 'HIGH' } });
    return presentEntry((await this.prisma.reconciliationEntry.findUniqueOrThrow({ where: { id: entryId } })));
  }
}
