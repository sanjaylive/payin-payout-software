import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type DbClient, notifyInbox, platformOrganizationId, type PrismaClient, type RiskRule } from '@pay2all/database';
import { metrics } from '@pay2all/telemetry';
import { type RiskActionValue, riskParamsSchemas, type RiskRuleTypeValue, SYNC_RULE_TYPES } from '@pay2all/validation';
import type Redis from 'ioredis';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import { PeriodUsageService } from '../limits/period-usage.service';
import {
  decide,
  evaluateAmountAnomaly,
  evaluateBeneficiaryFanIn,
  evaluateNewMerchantVolume,
  evaluateVelocity,
  type RiskDecision,
  type RiskHit,
} from './risk-evaluators';

const RULE_CACHE_MS = 15_000;
const STATS_CACHE_SECONDS = 600;

/** Payment statuses that represent money actually collected (for averages). */
const PAYIN_COLLECTED = ['SUCCESS', 'SETTLEMENT_PENDING', 'SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export interface RiskContext {
  service: 'PAYIN' | 'PAYOUT';
  merchantId: string;
  amountMinor: bigint;
  subjectType: 'PAYMENT' | 'PAYOUT';
  /** Id the transaction will get (allocated before the check so events can point at it). */
  subjectId: string;
  /** Payouts: the destination, for fan-in rules. */
  destination?: { accountHash: string | null; upiId: string | null };
}

export interface EvaluatedHit extends RiskHit {
  rule: RiskRule;
  enforced: boolean;
}

export interface RiskAssessment {
  context: RiskContext;
  decision: RiskDecision;
  hits: EvaluatedHit[];
}

export interface RecordedRisk {
  eventIds: string[];
  /** Events that need a reviewer (OPEN). */
  openEventIds: string[];
}

/**
 * Inline risk checks and the shared "record a hit" path (docs/RISK.md). Rules are read from the DB
 * and cached briefly per process. A rule that cannot be evaluated (Redis or DB hiccup) is skipped
 * and counted — risk is a control on top of limits and KYC, so it fails open rather than taking
 * payments down; the error metric is alerted on.
 */
@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);
  private cache: { at: number; rules: RiskRule[] } | null = null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly usage: PeriodUsageService,
  ) {}

  invalidateRules(): void {
    this.cache = null;
  }

  async enabledRules(): Promise<RiskRule[]> {
    if (this.cache && Date.now() - this.cache.at < RULE_CACHE_MS) return this.cache.rules;
    const rules = await this.prisma.riskRule.findMany({ where: { enabled: true }, orderBy: [{ priority: 'asc' }, { code: 'asc' }] });
    this.cache = { at: Date.now(), rules };
    return rules;
  }

  // ---- Inline assessment ------------------------------------------------------------------------

  async assess(ctx: RiskContext): Promise<RiskAssessment> {
    const rules = (await this.enabledRules()).filter((r) => r.service === ctx.service && SYNC_RULE_TYPES.includes(r.type));
    const hits: EvaluatedHit[] = [];
    for (const rule of rules) {
      try {
        const hit = await this.evaluate(rule, ctx);
        if (hit) hits.push({ ...hit, rule, enforced: rule.mode === 'ENFORCE' });
      } catch (err) {
        metrics.riskErrors.inc({ rule: rule.code });
        this.logger.warn({ err, rule: rule.code, merchantId: ctx.merchantId }, 'Risk rule evaluation failed; skipped');
      }
    }
    for (const h of hits) metrics.riskHits.inc({ rule: h.rule.code, action: h.rule.action, mode: h.rule.mode });
    const decision = decide(
      hits.filter((h) => h.enforced).map((h) => h.rule.action),
      ctx.service,
    );
    metrics.riskDecisions.inc({ service: ctx.service, decision });
    return { context: ctx, decision, hits };
  }

  private async evaluate(rule: RiskRule, ctx: RiskContext): Promise<RiskHit | null> {
    const type: RiskRuleTypeValue = rule.type;
    switch (type) {
      case 'VELOCITY': {
        const p = riskParamsSchemas.VELOCITY.parse(rule.params);
        return evaluateVelocity(p, { count: await this.slidingCount(`risk:vel:${rule.id}:${ctx.merchantId}`, ctx.subjectId, p.window_seconds) });
      }
      case 'AMOUNT_ANOMALY': {
        const p = riskParamsSchemas.AMOUNT_ANOMALY.parse(rule.params);
        if (ctx.amountMinor < p.min_amount) return null;
        const stats = await this.history(ctx.service, ctx.merchantId, p.lookback_days);
        const profile = await this.prisma.merchantProfile.findUnique({ where: { merchantId: ctx.merchantId }, select: { maximumTicketMinor: true } });
        return evaluateAmountAnomaly(p, { amountMinor: ctx.amountMinor, sampleCount: stats.count, sampleSumMinor: stats.sum, declaredMaxTicketMinor: profile?.maximumTicketMinor ?? null });
      }
      case 'NEW_MERCHANT_VOLUME': {
        const p = riskParamsSchemas.NEW_MERCHANT_VOLUME.parse(rule.params);
        const m = await this.prisma.merchant.findUnique({ where: { id: ctx.merchantId }, select: { approvedAt: true } });
        if (!m?.approvedAt) return null;
        const now = new Date();
        const approvedDaysAgo = Math.floor((now.getTime() - m.approvedAt.getTime()) / 86_400_000);
        if (approvedDaysAgo > p.new_merchant_days) return null;
        // Today's running total from the limits usage table: one primary-key read, exact.
        return evaluateNewMerchantVolume(p, { approvedDaysAgo, todayVolumeMinor: await this.usage.today(this.prisma, ctx.merchantId, ctx.service, now), amountMinor: ctx.amountMinor });
      }
      case 'BENEFICIARY_FAN_IN': {
        const p = riskParamsSchemas.BENEFICIARY_FAN_IN.parse(rule.params);
        const dest = ctx.destination;
        if (!dest || (!dest.accountHash && !dest.upiId)) return null;
        const since = new Date(Date.now() - p.window_seconds * 1000);
        // Platform-wide: the same account can be registered as a beneficiary by many merchants.
        const rows = dest.accountHash
          ? await this.prisma.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM payouts p JOIN beneficiaries b ON b.id = p.beneficiary_id
              WHERE b.account_number_hash = ${dest.accountHash} AND p.created_at >= ${since} AND p.status NOT IN ('REJECTED', 'FAILED')`
          : await this.prisma.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM payouts p JOIN beneficiaries b ON b.id = p.beneficiary_id
              WHERE lower(b.upi_id) = lower(${dest.upiId}) AND p.created_at >= ${since} AND p.status NOT IN ('REJECTED', 'FAILED')`;
        // +1: the payout being created now.
        return evaluateBeneficiaryFanIn(p, { count: (rows[0]?.n ?? 0) + 1, destination: dest.accountHash ? 'BANK_ACCOUNT' : 'UPI' });
      }
      default:
        return null; // async types are evaluated by the sweep
    }
  }

  /** Sliding-window counter (sorted set of member ids scored by time); includes this request. */
  private async slidingCount(key: string, member: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const res = await this.redis
      .multi()
      .zremrangebyscore(key, 0, now - windowSeconds * 1000)
      .zadd(key, now, member)
      .zcard(key)
      .pexpire(key, windowSeconds * 1000)
      .exec();
    const card = res?.[2];
    if (!card || card[0]) throw card?.[0] ?? new Error('Redis transaction aborted');
    return Number(card[1]);
  }

  /** Count and sum of collected volume over the lookback, cached for 10 minutes. */
  private async history(service: 'PAYIN' | 'PAYOUT', merchantId: string, lookbackDays: number): Promise<{ count: number; sum: bigint }> {
    const key = `risk:hist:${service}:${merchantId}:${lookbackDays}`;
    const cached = await this.redis.get(key);
    if (cached) {
      const [c, s] = cached.split(':');
      return { count: Number(c), sum: BigInt(s ?? '0') };
    }
    const since = new Date(Date.now() - lookbackDays * 86_400_000);
    const rows =
      service === 'PAYIN'
        ? await this.prisma.$queryRaw<Array<{ c: number; s: bigint }>>`
            SELECT count(*)::int AS c, COALESCE(sum(amount_minor), 0)::bigint AS s FROM payments
            WHERE merchant_id = ${merchantId} AND created_at >= ${since} AND status::text = ANY(${[...PAYIN_COLLECTED]})`
        : await this.prisma.$queryRaw<Array<{ c: number; s: bigint }>>`
            SELECT count(*)::int AS c, COALESCE(sum(amount_minor), 0)::bigint AS s FROM payouts
            WHERE merchant_id = ${merchantId} AND created_at >= ${since} AND status = 'SUCCESS'`;
    const out = { count: rows[0]?.c ?? 0, sum: rows[0]?.s ?? 0n };
    await this.redis.set(key, `${out.count}:${out.sum}`, 'EX', STATS_CACHE_SECONDS);
    return out;
  }

  // ---- Recording --------------------------------------------------------------------------------

  /**
   * Persist one event per hit and apply enforced merchant-level actions (hold, disable). Runs on the
   * caller's transaction when given, so the event commits with the transaction it describes.
   */
  async record(db: DbClient, a: RiskAssessment): Promise<RecordedRisk> {
    const out: RecordedRisk = { eventIds: [], openEventIds: [] };
    for (const h of a.hits) {
      const id = await this.recordHit(db, {
        rule: h.rule,
        merchantId: a.context.merchantId,
        subjectType: a.context.subjectType,
        subjectId: a.context.subjectId,
        hit: h,
        enforced: h.enforced,
      });
      if (!id) continue;
      out.eventIds.push(id.eventId);
      if (id.open) out.openEventIds.push(id.eventId);
    }
    return out;
  }

  /** Shared by inline checks and the sweep. Returns null when the dedupe key already exists. */
  async recordHit(
    db: DbClient,
    e: { rule: RiskRule; merchantId: string | null; subjectType: string; subjectId: string; hit: RiskHit; enforced: boolean; dedupeKey?: string },
  ): Promise<{ eventId: string; open: boolean } | null> {
    const action: RiskActionValue = e.rule.action;
    // A human must look at: explicit reviews, and any enforced control that stays on until lifted.
    const open = e.enforced && (action === 'MANUAL_REVIEW' || action === 'HOLD_SETTLEMENT' || action === 'DISABLE_PAYIN' || action === 'DISABLE_PAYOUT');
    const eventId = newId('riskEvent');
    if (e.dedupeKey) {
      const exists = await db.riskEvent.findUnique({ where: { dedupeKey: e.dedupeKey }, select: { id: true } });
      if (exists) return null;
    }
    await db.riskEvent.create({
      data: {
        id: eventId,
        ruleId: e.rule.id,
        ruleCode: e.rule.code,
        ruleVersion: e.rule.version,
        merchantId: e.merchantId,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        action,
        mode: e.rule.mode,
        enforced: e.enforced,
        reason: e.hit.reason.slice(0, 500),
        evidence: { ...e.hit.evidence, rule_params: e.rule.params as Record<string, string | number> },
        status: open ? 'OPEN' : 'RECORDED',
        dedupeKey: e.dedupeKey ?? null,
      },
    });
    if (e.enforced && e.merchantId) await this.applyMerchantAction(db, eventId, e.merchantId, action, e.rule.code);
    // Ring the risk team's bell for anything waiting on a reviewer (held payouts are announced by
    // the payout event itself, with the merchant's context).
    if (open && e.subjectType !== 'PAYOUT') {
      const platform = await platformOrganizationId(db);
      if (platform) {
        await notifyInbox(db, {
          organizationId: platform,
          audience: { permission: 'risk.review' },
          category: 'RISK',
          severity: action === 'DISABLE_PAYIN' || action === 'DISABLE_PAYOUT' ? 'CRITICAL' : 'WARNING',
          title: `Risk review needed: ${e.rule.name}`,
          body: e.hit.reason,
          link: '/admin/risk/reviews',
          resourceType: 'risk_event',
          resourceId: eventId,
          dedupeKey: `risk:${eventId}`,
        });
      }
    }
    return { eventId, open };
  }

  /** HOLD_SETTLEMENT / DISABLE_*: record what was changed so a reviewer can undo exactly that. */
  private async applyMerchantAction(db: DbClient, eventId: string, merchantId: string, action: RiskActionValue, ruleCode: string): Promise<void> {
    if (action === 'HOLD_SETTLEMENT') {
      const existing = await db.settlementHold.findFirst({ where: { merchantId, releasedAt: null }, select: { id: true } });
      const holdId = existing?.id ?? newId('settlementHold');
      if (!existing) await db.settlementHold.create({ data: { id: holdId, merchantId, reason: `Risk rule ${ruleCode}`, placedById: null } });
      // Only a hold this event created is released when the event is cleared.
      await db.riskActionRecord.create({ data: { id: newId('riskAction'), eventId, merchantId, type: action, holdId: existing ? null : holdId } });
      await this.audit.record({ action: 'risk.settlement_hold', resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, actor: { type: 'SYSTEM', id: null }, metadata: { event_id: eventId, rule: ruleCode, severity: 'HIGH' } }, db);
      return;
    }
    if (action === 'DISABLE_PAYIN' || action === 'DISABLE_PAYOUT') {
      const field = action === 'DISABLE_PAYIN' ? 'payinEnabled' : 'payoutEnabled';
      const m = await db.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { payinEnabled: true, payoutEnabled: true } });
      const previous = m[field];
      if (previous) await db.merchant.update({ where: { id: merchantId }, data: { [field]: false, version: { increment: 1 } } });
      await db.riskActionRecord.create({ data: { id: newId('riskAction'), eventId, merchantId, type: action, previousValue: previous } });
      await this.audit.record(
        { action: 'risk.service_disabled', resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, actor: { type: 'SYSTEM', id: null }, oldValue: { [field]: previous }, newValue: { [field]: false }, metadata: { event_id: eventId, rule: ruleCode, severity: 'CRITICAL' } },
        db,
      );
    }
  }
}
