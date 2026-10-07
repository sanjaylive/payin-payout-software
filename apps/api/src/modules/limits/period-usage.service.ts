import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';

const IST_OFFSET_MS = 330 * 60_000;

export type UsageService = 'PAYIN' | 'PAYOUT';

export interface PeriodLimits {
  dailyAmountMinor: bigint | null;
  dailyCount: number | null;
  monthlyAmountMinor: bigint | null;
  monthlyCount: number | null;
}

/** Resolved limit layers → numeric period limits. */
export function periodLimitsOf(l: { dailyAmountMinor: { value: bigint | number | null }; dailyCount: { value: bigint | number | null }; monthlyAmountMinor: { value: bigint | number | null }; monthlyCount: { value: bigint | number | null } }): PeriodLimits {
  const amt = (v: bigint | number | null) => (v === null ? null : BigInt(v));
  const cnt = (v: bigint | number | null) => (v === null ? null : Number(v));
  return { dailyAmountMinor: amt(l.dailyAmountMinor.value), dailyCount: cnt(l.dailyCount.value), monthlyAmountMinor: amt(l.monthlyAmountMinor.value), monthlyCount: cnt(l.monthlyCount.value) };
}

/** IST calendar keys for an instant: "D2026-10-07" and "M2026-10". */
export function periodKeys(at: Date): { day: string; month: string } {
  const ist = new Date(at.getTime() + IST_OFFSET_MS).toISOString();
  return { day: `D${ist.slice(0, 10)}`, month: `M${ist.slice(0, 7)}` };
}

/**
 * Daily/monthly limits from running totals (docs/perf/INDEX_REVIEW.md §3). `consume` increments the
 * merchant's day and month rows with the limit as the UPDATE condition, so the check and the
 * increment are one atomic statement: concurrent requests can never jointly overshoot a limit.
 * Every call runs on the caller's transaction, so a rolled-back create never consumes anything.
 * Totals are keyed by the transaction's own createdAt, so a release always hits the same rows.
 */
@Injectable()
export class PeriodUsageService {
  async consume(tx: TransactionClient, merchantId: string, service: UsageService, amountMinor: bigint, limits: PeriodLimits, at: Date): Promise<void> {
    const keys = periodKeys(at);
    const label = service === 'PAYIN' ? 'Payin' : 'Payout';
    for (const [period, amountLimit, countLimit, name] of [
      [keys.day, limits.dailyAmountMinor, limits.dailyCount, 'daily'],
      [keys.month, limits.monthlyAmountMinor, limits.monthlyCount, 'monthly'],
    ] as const) {
      if (amountLimit !== null && amountMinor > amountLimit) throw new AppError(ErrorCode.LIMIT_EXCEEDED, `${label} ${name} amount limit exceeded`);
      if (countLimit !== null && countLimit < 1) throw new AppError(ErrorCode.LIMIT_EXCEEDED, `${label} ${name} count limit exceeded`);
      const rows = await tx.$queryRaw<Array<{ amount_minor: bigint; count: number }>>`
        INSERT INTO merchant_period_usage (merchant_id, service, period, amount_minor, count, updated_at)
        VALUES (${merchantId}, ${service}::"ServiceType", ${period}, ${amountMinor}, 1, ${at})
        ON CONFLICT (merchant_id, service, period) DO UPDATE
          SET amount_minor = merchant_period_usage.amount_minor + EXCLUDED.amount_minor,
              count = merchant_period_usage.count + 1,
              updated_at = EXCLUDED.updated_at
          WHERE (${amountLimit}::bigint IS NULL OR merchant_period_usage.amount_minor + EXCLUDED.amount_minor <= ${amountLimit}::bigint)
            AND (${countLimit}::int IS NULL OR merchant_period_usage.count + 1 <= ${countLimit}::int)
        RETURNING amount_minor, count`;
      if (rows.length === 0) {
        // The row exists and the condition failed: work out which limit for the message.
        const [cur] = await tx.$queryRaw<Array<{ amount_minor: bigint; count: number }>>`
          SELECT amount_minor, count FROM merchant_period_usage WHERE merchant_id = ${merchantId} AND service = ${service}::"ServiceType" AND period = ${period}`;
        const countHit = countLimit !== null && cur !== undefined && cur.count + 1 > countLimit;
        throw new AppError(ErrorCode.LIMIT_EXCEEDED, `${label} ${name} ${countHit ? 'count' : 'amount'} limit exceeded`);
      }
    }
  }

  /** Undo a consume (failed, expired, cancelled or rejected). Never below zero. */
  async release(tx: TransactionClient, merchantId: string, service: UsageService, amountMinor: bigint, createdAt: Date): Promise<void> {
    const { day, month } = periodKeys(createdAt);
    await tx.$executeRaw`
      UPDATE merchant_period_usage
         SET amount_minor = GREATEST(amount_minor - ${amountMinor}, 0), count = GREATEST(count - 1, 0), updated_at = ${new Date()}
       WHERE merchant_id = ${merchantId} AND service = ${service}::"ServiceType" AND period IN (${day}, ${month})`;
  }

  /** Re-count without a limit check (a late success: the money has already moved). */
  async add(tx: TransactionClient, merchantId: string, service: UsageService, amountMinor: bigint, createdAt: Date): Promise<void> {
    const { day, month } = periodKeys(createdAt);
    for (const period of [day, month]) {
      await tx.$executeRaw`
        INSERT INTO merchant_period_usage (merchant_id, service, period, amount_minor, count, updated_at)
        VALUES (${merchantId}, ${service}::"ServiceType", ${period}, ${amountMinor}, 1, ${new Date()})
        ON CONFLICT (merchant_id, service, period) DO UPDATE
          SET amount_minor = merchant_period_usage.amount_minor + EXCLUDED.amount_minor, count = merchant_period_usage.count + 1, updated_at = EXCLUDED.updated_at`;
    }
  }

  /** Today's running total (risk heuristics). */
  async today(db: Pick<TransactionClient, '$queryRaw'>, merchantId: string, service: UsageService, at = new Date()): Promise<bigint> {
    const [row] = await db.$queryRaw<Array<{ amount_minor: bigint }>>`
      SELECT amount_minor FROM merchant_period_usage WHERE merchant_id = ${merchantId} AND service = ${service}::"ServiceType" AND period = ${periodKeys(at).day}`;
    return row?.amount_minor ?? 0n;
  }
}

/** Statuses whose amount counts towards period limits (unchanged from the original SUM filters). */
export const PAYIN_UNCOUNTED = new Set(['FAILED', 'EXPIRED', 'CANCELLED']);
export const PAYOUT_UNCOUNTED = new Set(['FAILED', 'REJECTED']);
