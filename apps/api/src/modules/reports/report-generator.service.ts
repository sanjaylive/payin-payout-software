import { createHash } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { notifyInbox, type PrismaClient, type ReportExport } from '@pay2all/database';
import { metrics } from '@pay2all/telemetry';
import type { ReportTypeValue } from '@pay2all/validation';
import { ApiConfig } from '../../config/api-config';
import { NotificationsService } from '../../infra/notifications.service';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { type Keyset, type ReportFilters, type ReportScope, REPORTS, withTenantReader } from './report-definitions';
import { type CellValue, writerFor } from './report-writer';

const BATCH = 5_000;
/** One export never exceeds this; larger needs → narrower date ranges (docs/REPORTS.md §2). */
export const MAX_REPORT_ROWS = 1_000_000;
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 30 * 60_000;
export const REPORT_TTL_MS = 7 * 86_400_000;

class ReportTooLarge extends Error {}

/**
 * Generates queued exports in the jobs process — never in an HTTP request (docs/REPORTS.md). Rows
 * are read in keyset batches, each batch in its own short transaction under the RLS reader role,
 * and streamed straight into a multipart upload, so memory stays flat however large the report.
 */
@Injectable()
export class ReportGeneratorService {
  private readonly logger = new Logger(ReportGeneratorService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly config: ApiConfig,
  ) {}

  private static readonly LABELS: Record<string, string> = { PAYMENTS: 'Payins', REFUNDS: 'Refunds', PAYOUTS: 'Payouts', SETTLEMENTS: 'Settlements', LOGIN_EVENTS: 'Login activity' };

  /** In-app notice to whoever asked for the export (always, unlike the opt-in email). */
  private async ringBell(exp: ReportExport, outcome: 'COMPLETED' | 'FAILED', rows?: number) {
    if (!exp.requestedById) return;
    const org = await this.prisma.organization.findUnique({ where: { id: exp.organizationId }, select: { type: true } });
    const path = org?.type === 'PLATFORM' ? '/admin/reports' : org?.type === 'RESELLER' ? '/reseller/reports' : org?.type === 'API_PARTNER' ? '/partner/reports' : '/reports';
    const label = ReportGeneratorService.LABELS[exp.type] ?? exp.type;
    await notifyInbox(this.prisma, {
      organizationId: exp.organizationId,
      audience: { userIds: [exp.requestedById] },
      category: 'REPORT',
      severity: outcome === 'COMPLETED' ? 'SUCCESS' : 'WARNING',
      title: outcome === 'COMPLETED' ? `${label} export is ready` : `${label} export failed`,
      body: outcome === 'COMPLETED' ? `${(rows ?? 0).toLocaleString('en-IN')} rows · available for 7 days.` : 'Please request it again.',
      link: path,
      resourceType: 'report_export',
      resourceId: exp.id,
      dedupeKey: `report:${exp.id}:${outcome}`,
    });
  }

  /**
   * "Email me": tell the requester the file is ready (or failed). The email carries a link to the
   * reports page — never the data — so downloading still needs a signed-in, authorised session.
   */
  private async notifyRequester(exp: ReportExport, outcome: 'COMPLETED' | 'FAILED', rows?: number) {
    if (!exp.notifyByEmail || !exp.requestedById) return;
    const user = await this.prisma.user.findUnique({ where: { id: exp.requestedById }, select: { email: true, name: true } });
    if (!user?.email) return;
    const org = await this.prisma.organization.findUnique({ where: { id: exp.organizationId }, select: { type: true } });
    const path = org?.type === 'PLATFORM' ? '/admin/reports' : org?.type === 'RESELLER' ? '/reseller/reports' : org?.type === 'API_PARTNER' ? '/partner/reports' : '/reports';
    const f = exp.filters as unknown as ReportFilters;
    const label = ReportGeneratorService.LABELS[exp.type] ?? exp.type;
    const link = `${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}${path}`;
    const text =
      outcome === 'COMPLETED'
        ? `Hi ${user.name},\n\nYour ${label} export for ${f.from} to ${f.to} is ready (${rows ?? 0} rows).\n\nDownload it after signing in: ${link}\nThe file is available for 7 days.`
        : `Hi ${user.name},\n\nYour ${label} export for ${f.from} to ${f.to} could not be generated. Please request it again from ${link}.`;
    await this.notifications.queue(this.prisma, {
      to: user.email,
      subject: outcome === 'COMPLETED' ? `Your ${label} export is ready` : `Your ${label} export failed`,
      text,
      template: outcome === 'COMPLETED' ? 'report_ready' : 'report_failed',
      userId: exp.requestedById,
    });
  }

  async processQueued(limit = 2): Promise<number> {
    const now = new Date();
    // A crashed generator leaves RUNNING rows behind: retry them (bounded) or give up.
    await this.prisma.$executeRaw`
      UPDATE report_exports SET status = (CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'FAILED' ELSE 'QUEUED' END)::"ReportExportStatus",
        error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'Generation did not finish; please request the report again' ELSE error END
      WHERE status = 'RUNNING' AND started_at < ${new Date(now.getTime() - STALE_RUNNING_MS)}`;
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE report_exports SET status = 'RUNNING', started_at = ${now}, attempts = attempts + 1
      WHERE id IN (SELECT id FROM report_exports WHERE status = 'QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})
      RETURNING id`;
    for (const { id } of claimed) await this.generate(id);
    return claimed.length;
  }

  async generate(id: string): Promise<void> {
    const exp = await this.prisma.reportExport.findUniqueOrThrow({ where: { id } });
    const type: ReportTypeValue = exp.type;
    const def = REPORTS[type];
    const scope: ReportScope = { kind: exp.scopeKind as ReportScope['kind'], id: exp.scopeId };
    const filters = exp.filters as unknown as ReportFilters;
    const writer = writerFor(exp.format);
    const key = `reports/${exp.organizationId}/${exp.id}.${writer.extension}`;

    const hash = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    pipeline(writer.stream, counter, () => undefined);
    const upload = this.storage.putStream(key, counter, writer.contentType).catch((err: unknown) => {
      counter.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    });
    // Handled below (awaited on both paths); this only stops an early rejection being "unhandled".
    upload.catch(() => undefined);

    let rows = 0;
    try {
      await writer.writeHeader(def.columns(scope));
      let cursor: Keyset | null = null;
      for (;;) {
        const after: Keyset | null = cursor;
        const batch: Array<{ keyset: Keyset; cells: CellValue[] }> = await this.prisma.$transaction((tx) => withTenantReader(tx, scope, () => def.fetch(tx, scope, filters, after, BATCH)));
        for (const r of batch) await writer.writeRow(r.cells);
        rows += batch.length;
        if (rows > MAX_REPORT_ROWS) throw new ReportTooLarge();
        if (batch.length < BATCH) break;
        cursor = batch[batch.length - 1]!.keyset;
      }
      await writer.end();
      await upload;
      const completedAt = new Date();
      await this.prisma.reportExport.update({
        where: { id },
        data: { status: 'COMPLETED', rowCount: rows, fileSize: BigInt(size), sha256: hash.digest('hex'), storageKey: key, completedAt, expiresAt: new Date(completedAt.getTime() + REPORT_TTL_MS), error: null },
      });
      metrics.reportExports.inc({ type, outcome: 'completed' });
      metrics.reportRows.inc({ type }, rows);
      await this.notifyRequester(exp, 'COMPLETED', rows);
      await this.ringBell(exp, 'COMPLETED', rows);
    } catch (err) {
      counter.destroy();
      await upload.catch(() => undefined);
      await this.storage.delete(key).catch(() => undefined);
      await this.fail(exp, err);
    }
  }

  private async fail(exp: ReportExport, err: unknown) {
    const tooLarge = err instanceof ReportTooLarge;
    const retry = !tooLarge && exp.attempts < MAX_ATTEMPTS;
    if (!tooLarge) this.logger.error({ err, exportId: exp.id }, 'Report generation failed');
    await this.prisma.reportExport.update({
      where: { id: exp.id },
      data: {
        status: retry ? 'QUEUED' : 'FAILED',
        error: tooLarge ? `More than ${MAX_REPORT_ROWS.toLocaleString('en-IN')} rows; choose a shorter date range` : retry ? null : 'Generation failed; please request the report again',
      },
    });
    metrics.reportExports.inc({ type: exp.type, outcome: retry ? 'retry' : 'failed' });
    if (!retry) {
      await this.notifyRequester(exp, 'FAILED');
      await this.ringBell(exp, 'FAILED');
    }
  }

  /** Completed exports are downloadable for 7 days, then the file is deleted. */
  async expireOld(now = new Date()): Promise<number> {
    const due = await this.prisma.reportExport.findMany({ where: { status: 'COMPLETED', expiresAt: { lt: now } }, select: { id: true, storageKey: true }, take: 500 });
    for (const e of due) {
      if (e.storageKey) await this.storage.delete(e.storageKey).catch((err: unknown) => this.logger.warn({ err, exportId: e.id }, 'Could not delete expired report file'));
      await this.prisma.reportExport.update({ where: { id: e.id }, data: { status: 'EXPIRED', storageKey: null } });
    }
    return due.length;
  }
}
