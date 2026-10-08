import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { analyticsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import type { Actor } from '../auth/actor';

type Query = z.output<typeof analyticsQuerySchema>;
const LIVE_MINUTES = 15;

/**
 * Outcome definitions match the dashboard stats: a payin succeeded once captured to the ledger and
 * failed when FAILED or EXPIRED; a payout succeeded once settled and failed when FAILED. Success rate
 * = success / (success + failed): in-flight transactions are left out rather than counted as failures.
 */
const KINDS = {
  payin: { table: Prisma.raw('payments'), ok: Prisma.raw('capture_journal_id IS NOT NULL'), failed: Prisma.raw(`status IN ('FAILED', 'EXPIRED')`), dim: Prisma.raw('method'), code: Prisma.raw(`COALESCE(failure_code, CASE WHEN status = 'EXPIRED' THEN 'EXPIRED' END, 'UNKNOWN')`) },
  payout: { table: Prisma.raw('payouts'), ok: Prisma.raw('settle_journal_id IS NOT NULL'), failed: Prisma.raw(`status = 'FAILED'`), dim: Prisma.raw('mode'), code: Prisma.raw(`COALESCE(failure_code, 'UNKNOWN')`) },
} as const;

interface Counts {
  total: bigint;
  success: bigint;
  failed: bigint;
  amount: string | null;
}

const rate = (success: number, failed: number) => (success + failed ? Math.round((success / (success + failed)) * 10_000) / 10_000 : null);
const shape = (r: Counts) => {
  const success = Number(r.success);
  const failed = Number(r.failed);
  return { count: Number(r.total), success_count: success, failed_count: failed, success_rate: rate(success, failed), success_amount: minorToMajorString(BigInt(r.amount ?? '0')) };
};

/** Live analytics (docs/ANALYTICS.md): success rate by method and gateway, failure reasons, peak hours. */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
  ) {}

  async overview(actor: Actor, q: Query) {
    if (!actor.permissions.has(q.kind === 'payin' ? 'payin.read' : 'payout.read')) throw new AppError(ErrorCode.FORBIDDEN, `You don't have access to ${q.kind} data`);
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const merchants = q.merchant_id ? [q.merchant_id] : ids;
    const k = KINDS[q.kind];
    const from = new Date(q.from);
    const to = new Date(q.to);
    const where = Prisma.sql`created_at >= ${from} AND created_at < ${to} AND (${merchants === null} OR merchant_id = ANY(${merchants ?? []}::text[]))`;
    const counts = Prisma.sql`COUNT(*) AS total, COUNT(*) FILTER (WHERE ${k.ok}) AS success, COUNT(*) FILTER (WHERE ${k.failed}) AS failed, SUM(amount_minor) FILTER (WHERE ${k.ok})::text AS amount`;
    const liveFrom = new Date(Date.now() - LIVE_MINUTES * 60_000);
    const platform = ids === null;

    const [[totals], [live], byDim, byGateway, reasons, hours] = await Promise.all([
      this.prisma.$queryRaw<Counts[]>`SELECT ${counts} FROM ${k.table} WHERE ${where}`,
      this.prisma.$queryRaw<Counts[]>`SELECT ${counts} FROM ${k.table} WHERE created_at >= ${liveFrom} AND (${merchants === null} OR merchant_id = ANY(${merchants ?? []}::text[]))`,
      this.prisma.$queryRaw<(Counts & { key: string })[]>`SELECT ${k.dim}::text AS key, ${counts} FROM ${k.table} WHERE ${where} GROUP BY 1 ORDER BY total DESC`,
      // Gateways are platform-internal: only platform users see them.
      platform
        ? this.prisma.$queryRaw<(Counts & { provider_id: string; code: string; name: string })[]>`
            SELECT t.provider_id, p.code, p.name, t.total, t.success, t.failed, t.amount
              FROM (SELECT provider_id, ${counts} FROM ${k.table} WHERE ${where} AND provider_id IS NOT NULL GROUP BY 1) t
              JOIN providers p ON p.id = t.provider_id
             ORDER BY t.total DESC`
        : Promise.resolve(null),
      this.prisma.$queryRaw<{ code: string; reason: string | null; n: bigint }[]>`
        SELECT ${k.code} AS code, MAX(failure_reason) AS reason, COUNT(*) AS n FROM ${k.table}
         WHERE ${where} AND ${k.failed} GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      this.prisma.$queryRaw<(Counts & { hour: number })[]>`
        SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, ${counts} FROM ${k.table}
         WHERE ${where} GROUP BY 1`,
    ]);

    const t = shape(totals!);
    const byHour = new Map(hours.map((h) => [h.hour, shape(h)]));
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, ...(byHour.get(hour) ?? shape({ total: 0n, success: 0n, failed: 0n, amount: null })) }));
    const peak = hourly.reduce((best, h) => (h.count > best.count ? h : best), hourly[0]!);
    return {
      kind: q.kind,
      from,
      to,
      totals: { ...t, avg_ticket: t.success_count ? minorToMajorString(BigInt(totals!.amount ?? '0') / BigInt(t.success_count)) : null },
      live: { window_minutes: LIVE_MINUTES, ...shape(live!) },
      by_method: byDim.map((r) => ({ method: r.key, ...shape(r) })),
      by_gateway: byGateway?.map((r) => ({ provider_id: r.provider_id, code: r.code, name: r.name, ...shape(r) })) ?? null,
      failure_reasons: reasons.map((r) => ({ code: r.code, reason: r.reason, count: Number(r.n), share: t.failed_count ? Math.round((Number(r.n) / t.failed_count) * 10_000) / 10_000 : 0 })),
      hours: hourly,
      peak_hour: peak.count ? peak.hour : null,
    };
  }
}
