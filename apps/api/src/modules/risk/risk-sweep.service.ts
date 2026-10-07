import { Inject, Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation, Prisma, type PrismaClient, type RiskRule } from '@pay2all/database';
import { metrics } from '@pay2all/telemetry';
import { ASYNC_RULE_TYPES, riskParamsSchemas } from '@pay2all/validation';
import { PRISMA } from '../../infra/tokens';
import { RiskEngineService } from './risk-engine.service';
import { evaluateFailedAttempts, evaluateSharedBankAccount, evaluateVolumeSpike, type RiskHit } from './risk-evaluators';

const IST_OFFSET_MS = 330 * 60_000;
/** Cap per rule per sweep so one noisy rule cannot starve the rest. */
const MAX_HITS_PER_RULE = 200;

function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Background risk rules over aggregates (docs/RISK.md §3.2), run by the jobs process every few
 * minutes. Each hit is deduplicated per rule version, subject and window, so re-running a sweep
 * never raises the same alarm twice — but a rule edit (new version) evaluates afresh.
 * All windows use the application clock, like every other queue in the system.
 */
@Injectable()
export class RiskSweepService {
  private readonly logger = new Logger(RiskSweepService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly engine: RiskEngineService,
  ) {}

  async run(now = new Date()): Promise<{ hits: number }> {
    const rules = (await this.engine.enabledRules()).filter((r) => ASYNC_RULE_TYPES.includes(r.type));
    let hits = 0;
    for (const rule of rules) {
      try {
        hits += await this.sweep(rule, now);
      } catch (err) {
        metrics.riskErrors.inc({ rule: rule.code });
        this.logger.error({ err, rule: rule.code }, 'Risk sweep failed for rule');
      }
    }
    return { hits };
  }

  private async sweep(rule: RiskRule, now: Date): Promise<number> {
    // Whitelisted identifiers only (never user input): the table and its "still live" predicate.
    const table = Prisma.raw(rule.service === 'PAYIN' ? 'payments' : 'payouts');
    switch (rule.type) {
      case 'VOLUME_SPIKE': {
        const p = riskParamsSchemas.VOLUME_SPIKE.parse(rule.params);
        const dayAgo = new Date(now.getTime() - 86_400_000);
        const baselineFrom = new Date(dayAgo.getTime() - p.baseline_days * 86_400_000);
        const notLive = Prisma.raw(rule.service === 'PAYIN' ? `('FAILED', 'EXPIRED', 'CANCELLED')` : `('FAILED', 'REJECTED')`);
        // Candidates first (last-24h volume ≥ floor), then each one's baseline — both on (merchant_id, created_at).
        const rows = await this.prisma.$queryRaw<Array<{ merchant_id: string; recent: bigint; baseline: bigint }>>(Prisma.sql`
          WITH recent AS (
            SELECT merchant_id, sum(amount_minor)::bigint AS recent FROM ${table}
            WHERE created_at >= ${dayAgo} AND created_at < ${now} AND status::text NOT IN ${notLive}
            GROUP BY merchant_id HAVING sum(amount_minor) >= ${p.min_amount})
          SELECT r.merchant_id, r.recent,
            (SELECT COALESCE(sum(t.amount_minor), 0)::bigint FROM ${table} t
             WHERE t.merchant_id = r.merchant_id AND t.created_at >= ${baselineFrom} AND t.created_at < ${dayAgo} AND t.status::text NOT IN ${notLive}) AS baseline
          FROM recent r LIMIT ${MAX_HITS_PER_RULE * 5}`);
        let n = 0;
        for (const r of rows) {
          const hit = evaluateVolumeSpike(p, { last24hMinor: r.recent, baselineTotalMinor: r.baseline });
          if (hit && (await this.raise(rule, r.merchant_id, 'MERCHANT', r.merchant_id, hit, `${istDate(now)}`))) n++;
          if (n >= MAX_HITS_PER_RULE) break;
        }
        return n;
      }
      case 'FAILED_ATTEMPTS': {
        const p = riskParamsSchemas.FAILED_ATTEMPTS.parse(rule.params);
        const windowMs = p.window_minutes * 60_000;
        const since = new Date(now.getTime() - windowMs);
        const rows = await this.prisma.$queryRaw<Array<{ merchant_id: string; failed: number; total: number }>>(Prisma.sql`
          SELECT merchant_id, count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*)::int AS total
          FROM ${table} WHERE created_at >= ${since} AND created_at < ${now}
          GROUP BY merchant_id HAVING count(*) FILTER (WHERE status = 'FAILED') >= ${p.min_failed}
          LIMIT ${MAX_HITS_PER_RULE * 5}`);
        let n = 0;
        const bucket = Math.floor(now.getTime() / windowMs);
        for (const r of rows) {
          const hit = evaluateFailedAttempts(p, { failed: r.failed, total: r.total });
          if (hit && (await this.raise(rule, r.merchant_id, 'MERCHANT', r.merchant_id, hit, `w${bucket}`))) n++;
          if (n >= MAX_HITS_PER_RULE) break;
        }
        return n;
      }
      case 'SHARED_BANK_ACCOUNT': {
        const p = riskParamsSchemas.SHARED_BANK_ACCOUNT.parse(rule.params);
        const since = new Date(now.getTime() - p.lookback_days * 86_400_000);
        const rows = await this.prisma.$queryRaw<Array<{ hash: string; merchants: string[]; payouts: number }>>`
          SELECT b.account_number_hash AS hash, array_agg(DISTINCT p.merchant_id ORDER BY p.merchant_id) AS merchants, count(*)::int AS payouts
          FROM payouts p JOIN beneficiaries b ON b.id = p.beneficiary_id
          WHERE p.created_at >= ${since} AND p.created_at < ${now} AND b.account_number_hash IS NOT NULL AND p.status NOT IN ('REJECTED')
          GROUP BY b.account_number_hash HAVING count(DISTINCT p.merchant_id) >= ${p.min_merchants}
          LIMIT ${MAX_HITS_PER_RULE}`;
        let n = 0;
        for (const r of rows) {
          const hit = evaluateSharedBankAccount(p, { merchantIds: r.merchants, payoutCount: r.payouts });
          if (hit && (await this.raise(rule, null, 'BENEFICIARY_ACCOUNT', r.hash, hit, istDate(now)))) n++;
        }
        return n;
      }
      default:
        return 0;
    }
  }

  private async raise(rule: RiskRule, merchantId: string | null, subjectType: string, subjectId: string, hit: RiskHit, window: string): Promise<boolean> {
    const dedupeKey = `${rule.id}:v${rule.version}:${subjectId}:${window}`.slice(0, 200);
    try {
      const recorded = await this.prisma.$transaction((tx) =>
        this.engine.recordHit(tx, { rule, merchantId, subjectType, subjectId, hit, enforced: rule.mode === 'ENFORCE', dedupeKey }),
      );
      if (!recorded) return false;
      metrics.riskHits.inc({ rule: rule.code, action: rule.action, mode: rule.mode });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}
