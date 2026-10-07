import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { LoginOutcome, PaymentStatus, PayoutStatus, type Prisma, type PrismaClient, RefundStatus, type ReportExport, SettlementStatus } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { createReportExportSchema, listReportExportsQuerySchema, ReportTypeValue } from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import type { ReportScope } from './report-definitions';

/** Per organization, so one tenant cannot fill the generator queue. */
const MAX_IN_PROGRESS = 3;

const STATUSES: Record<ReportTypeValue, readonly string[]> = {
  PAYMENTS: Object.values(PaymentStatus),
  REFUNDS: Object.values(RefundStatus),
  PAYOUTS: Object.values(PayoutStatus),
  SETTLEMENTS: Object.values(SettlementStatus),
  LOGIN_EVENTS: Object.values(LoginOutcome),
};

export function presentExport(e: ReportExport) {
  return {
    export_id: e.id,
    type: e.type,
    format: e.format,
    filters: e.filters,
    status: e.status,
    row_count: e.rowCount,
    file_size: e.fileSize === null ? null : Number(e.fileSize),
    sha256: e.sha256,
    error: e.error,
    requested_by_id: e.requestedById,
    created_at: e.createdAt,
    completed_at: e.completedAt,
    expires_at: e.expiresAt,
    notify_by_email: e.notifyByEmail,
    downloadable: e.status === 'COMPLETED' && !!e.storageKey && !!e.expiresAt && e.expiresAt > new Date(),
  };
}

/**
 * Report export requests and downloads (docs/REPORTS.md). The tenant scope is fixed when the export
 * is requested and travels with it; the generator never re-derives it. Exports belong to the
 * requesting organization: only its members can list or download them.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private scopeOf(actor: Actor): ReportScope {
    const s = this.scope.scopeOf(actor);
    if (s.kind === 'ALL') return { kind: 'PLATFORM', id: null };
    if (s.kind === 'RESELLER') return { kind: 'RESELLER', id: s.resellerOrgId };
    return { kind: 'MERCHANT', id: s.orgId };
  }

  async create(actor: Actor, input: z.output<typeof createReportExportSchema>) {
    const scope = this.scopeOf(actor);
    if (input.merchant_id) {
      if (scope.kind === 'MERCHANT' && input.merchant_id !== scope.id) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found');
      const org = await this.scope.requireOrganization(actor, input.merchant_id);
      if (org.type !== 'MERCHANT' && input.type !== 'LOGIN_EVENTS') throw new AppError(ErrorCode.INVALID_REQUEST, 'merchant_id must be a merchant');
    }
    if (input.status && !STATUSES[input.type].includes(input.status)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `status must be one of ${STATUSES[input.type].join(', ')}`, [{ path: 'status', message: 'Unknown status for this report type' }]);
    }
    const inProgress = await this.prisma.reportExport.count({ where: { organizationId: actor.organizationId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (inProgress >= MAX_IN_PROGRESS) throw new AppError(ErrorCode.RATE_LIMITED, `At most ${MAX_IN_PROGRESS} exports can be in progress at once; wait for one to finish`);

    const filters: Prisma.InputJsonObject = { from: input.from, to: input.to, ...(input.status ? { status: input.status } : {}), ...(input.merchant_id ? { merchant_id: input.merchant_id } : {}) };
    const e = await this.prisma.reportExport.create({
      data: { id: newId('reportExport'), organizationId: actor.organizationId, scopeKind: scope.kind, scopeId: scope.id, type: input.type, format: input.format, filters, requestedById: actor.userId, notifyByEmail: input.notify_by_email },
    });
    await this.audit.record({ action: 'report.requested', resourceType: 'report_export', resourceId: e.id, metadata: { type: input.type, ...filters } });
    return presentExport(e);
  }

  async list(actor: Actor, q: z.output<typeof listReportExportsQuerySchema>) {
    const rows = await this.prisma.reportExport.findMany({
      where: { AND: [{ organizationId: actor.organizationId }, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentExport);
  }

  private async own(actor: Actor, id: string) {
    const e = await this.prisma.reportExport.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, 'Export not found');
    return e;
  }

  async get(actor: Actor, id: string) {
    return presentExport(await this.own(actor, id));
  }

  /** Streams the file through the API (authorised and audited) — no public or pre-signed URLs. */
  async download(actor: Actor, id: string, res: Response): Promise<void> {
    const e = await this.own(actor, id);
    if (!presentExport(e).downloadable) throw new AppError(ErrorCode.CONFLICT, e.status === 'COMPLETED' || e.status === 'EXPIRED' ? 'This export has expired; request it again' : 'This export is not ready yet');
    const stream = await this.storage.getStream(e.storageKey!);
    await this.audit.record({ action: 'report.downloaded', resourceType: 'report_export', resourceId: e.id, metadata: { type: e.type, rows: e.rowCount } });
    const f = e.filters as { from: string; to: string };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pay2all-${e.type.toLowerCase().replace('_', '-')}-${f.from}-to-${f.to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    if (e.fileSize !== null) res.setHeader('Content-Length', e.fileSize.toString());
    if (e.sha256) res.setHeader('X-Content-SHA256', e.sha256);
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      stream.pipe(res);
    });
  }
}
