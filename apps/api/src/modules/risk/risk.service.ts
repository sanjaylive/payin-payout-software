import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type Prisma, type PrismaClient, type RiskActionRecord, type RiskEvent, type TransactionClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import {
  checkRule,
  type createRiskRuleSchema,
  type listRiskActionsQuerySchema,
  type listRiskEventsQuerySchema,
  type resolveRiskEventSchema,
  type RiskActionValue,
  type updateRiskRuleSchema,
} from '@pay2all/validation';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutTransitionsService } from '../payouts/payout-transitions.service';
import { APPROVAL_TTL_MS } from '../payouts/payouts.service';
import { RiskEngineService } from './risk-engine.service';
import { presentRiskAction, presentRiskEvent, presentRiskRule, presentRiskSubject } from './risk.presenter';

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

/**
 * Risk configuration and the manual review queue (docs/RISK.md §5–6). Platform staff only. Every
 * change is audited; reviews need a note; clearing undoes exactly what the event's actions changed.
 */
@Injectable()
export class RiskService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly engine: RiskEngineService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutTransitionsService,
    private readonly audit: AuditService,
  ) {}

  // ---- Rules ------------------------------------------------------------------------------------

  async listRules(actor: Actor) {
    platformOnly(actor);
    const rules = await this.prisma.riskRule.findMany({ orderBy: [{ service: 'asc' }, { priority: 'asc' }, { code: 'asc' }] });
    const since = new Date(Date.now() - 86_400_000);
    const hits = await this.prisma.riskEvent.groupBy({ by: ['ruleId'], where: { createdAt: { gte: since } }, _count: true });
    const byRule = new Map(hits.map((h) => [h.ruleId, h._count]));
    return rules.map((r) => ({ ...presentRiskRule(r), hits_24h: byRule.get(r.id) ?? 0 }));
  }

  async createRule(actor: Actor, input: z.output<typeof createRiskRuleSchema>) {
    platformOnly(actor);
    try {
      const rule = await this.prisma.riskRule.create({
        data: {
          id: newId('riskRule'),
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          service: input.service,
          params: input.params as Prisma.InputJsonValue,
          action: input.action,
          mode: input.mode,
          enabled: input.enabled,
          priority: input.priority,
          updatedById: actor.userId,
        },
      });
      await this.audit.record({ action: 'risk.rule.created', resourceType: 'risk_rule', resourceId: rule.id, newValue: presentRiskRule(rule) });
      this.engine.invalidateRules();
      return presentRiskRule(rule);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'A rule with this code already exists');
      throw err;
    }
  }

  async updateRule(actor: Actor, id: string, input: z.output<typeof updateRiskRuleSchema>) {
    platformOnly(actor);
    const before = await this.prisma.riskRule.findUnique({ where: { id } });
    if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Risk rule not found');
    const action: RiskActionValue = input.action ?? before.action;
    const params = input.params ?? (before.params as Record<string, unknown>);
    // Re-validate the merged rule against its (immutable) type and service.
    const check = z.unknown().superRefine((_v, ctx) => checkRule(before.type, before.service, action, params, ctx)).safeParse(null);
    if (!check.success) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Invalid rule', check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const res = await this.prisma.riskRule.updateMany({
      where: { id, version: before.version },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        action,
        params: params as Prisma.InputJsonValue,
        version: { increment: 1 },
        updatedById: actor.userId,
      },
    });
    if (res.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'The rule was changed by someone else; reload and try again');
    const after = await this.prisma.riskRule.findUniqueOrThrow({ where: { id } });
    await this.audit.record({ action: 'risk.rule.updated', resourceType: 'risk_rule', resourceId: id, oldValue: presentRiskRule(before), newValue: presentRiskRule(after), metadata: { reason: input.reason, severity: 'HIGH' } });
    this.engine.invalidateRules();
    return presentRiskRule(after);
  }

  // ---- Events -----------------------------------------------------------------------------------

  private async names(merchantIds: Array<string | null>) {
    const ids = [...new Set(merchantIds.filter((m): m is string => !!m))];
    if (!ids.length) return new Map<string, string>();
    const orgs = await this.prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(orgs.map((o) => [o.id, o.name]));
  }

  async listEvents(actor: Actor, q: z.output<typeof listRiskEventsQuerySchema>) {
    platformOnly(actor);
    const rows = await this.prisma.riskEvent.findMany({
      where: {
        AND: [
          q.status ? { status: q.status } : {},
          q.merchant_id ? { merchantId: q.merchant_id } : {},
          q.rule_id ? { ruleId: q.rule_id } : {},
          q.subject_id ? { subjectId: q.subject_id } : {},
          q.enforced !== undefined ? { enforced: q.enforced } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const names = await this.names(rows.map((r) => r.merchantId));
    return toPage(rows, q.limit, (e) => presentRiskEvent(e, names.get(e.merchantId ?? '') ?? null));
  }

  async getEvent(actor: Actor, id: string) {
    platformOnly(actor);
    const e = await this.prisma.riskEvent.findUnique({ where: { id }, include: { actions: { orderBy: { createdAt: 'asc' } } } });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, 'Risk event not found');
    const names = await this.names([e.merchantId]);
    const subject =
      e.subjectType === 'PAYOUT'
        ? await this.prisma.payout.findUnique({ where: { id: e.subjectId }, select: { status: true, reviewKind: true, amountMinor: true, mode: true } })
        : e.subjectType === 'PAYMENT'
          ? await this.prisma.payment.findUnique({ where: { id: e.subjectId }, select: { status: true, amountMinor: true, method: true } })
          : null;
    return {
      ...presentRiskEvent(e, names.get(e.merchantId ?? '') ?? null),
      actions: e.actions.map(presentRiskAction),
      subject: subject ? presentRiskSubject(e.subjectType, e.subjectId, subject) : null,
    };
  }

  /**
   * CLEAR: false positive — lift this event's actions; a payout it held moves on to approvals or the
   * queue once no other open event holds it. CONFIRM: genuine — keep the actions; a payout it held
   * is rejected and its reservation released (other open events on that payout close with it).
   */
  async resolve(actor: Actor, id: string, input: z.output<typeof resolveRiskEventSchema>) {
    platformOnly(actor);
    const ev = await this.prisma.riskEvent.findUnique({ where: { id } });
    if (!ev) throw new AppError(ErrorCode.NOT_FOUND, 'Risk event not found');
    if (ev.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This event is not awaiting review');
    const status = input.decision === 'CLEAR' ? 'CLEARED' : 'CONFIRMED';
    const now = new Date();
    const payoutOutcome = await this.ledger.run(async (tx) => {
      const res = await tx.riskEvent.updateMany({ where: { id, status: 'OPEN' }, data: { status, reviewedById: actor.userId, reviewedAt: now, reviewNote: input.note } });
      if (res.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'This event was resolved by someone else');
      if (input.decision === 'CLEAR') {
        const actions = await tx.riskActionRecord.findMany({ where: { eventId: id, active: true } });
        for (const a of actions) await this.liftInTx(tx, a, actor.userId, `Event cleared: ${input.note}`);
      }
      return ev.subjectType === 'PAYOUT' ? this.settleHeldPayout(tx, ev, input.decision, actor.userId) : null;
    });
    await this.audit.record({
      action: input.decision === 'CLEAR' ? 'risk.event.cleared' : 'risk.event.confirmed',
      resourceType: 'risk_event',
      resourceId: id,
      organizationId: ev.merchantId,
      metadata: { note: input.note, rule: ev.ruleCode, subject: `${ev.subjectType}:${ev.subjectId}`, payout: payoutOutcome, severity: 'HIGH' },
    });
    return this.getEvent(actor, id);
  }

  private async settleHeldPayout(tx: TransactionClient, ev: RiskEvent, decision: 'CLEAR' | 'CONFIRM', reviewerId: string): Promise<string | null> {
    const p = await this.payouts.lock(tx, ev.subjectId);
    if (p.status !== 'MANUAL_REVIEW' || p.reviewKind !== 'RISK') return null;
    if (decision === 'CONFIRM') {
      await tx.riskEvent.updateMany({
        where: { subjectType: 'PAYOUT', subjectId: p.id, status: 'OPEN', id: { not: ev.id } },
        data: { status: 'CONFIRMED', reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: `Closed with ${ev.id}` },
      });
      await this.payouts.release(tx, p, 'REJECTED', { code: 'RISK_DECLINED', reason: 'Declined after risk review' });
      return 'REJECTED';
    }
    const stillOpen = await tx.riskEvent.count({ where: { subjectType: 'PAYOUT', subjectId: p.id, status: 'OPEN' } });
    if (stillOpen > 0) return 'STILL_HELD';
    const now = new Date();
    const next =
      p.approvalsRequired > 0
        ? await this.payouts.transition(tx, p, 'APPROVAL_PENDING', { reviewReason: null, approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS) })
        : await this.payouts.transition(tx, p, 'QUEUED', { reviewReason: null, queuedAt: now, nextAttemptAt: now });
    if (next.status === 'QUEUED') await this.payouts.emit(tx, next, 'payout.queued');
    return next.status;
  }

  // ---- Actions ----------------------------------------------------------------------------------

  async listActions(actor: Actor, q: z.output<typeof listRiskActionsQuerySchema>) {
    platformOnly(actor);
    const rows = await this.prisma.riskActionRecord.findMany({
      where: { active: q.active, ...(q.merchant_id ? { merchantId: q.merchant_id } : {}) },
      include: { event: { select: { ruleCode: true, reason: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const names = await this.names(rows.map((r) => r.merchantId));
    return rows.map((r) => ({ ...presentRiskAction(r), merchant_name: names.get(r.merchantId) ?? null, rule_code: r.event.ruleCode, event_reason: r.event.reason }));
  }

  async liftAction(actor: Actor, id: string, reason: string) {
    platformOnly(actor);
    const a = await this.prisma.riskActionRecord.findUnique({ where: { id } });
    if (!a || !a.active) throw new AppError(ErrorCode.NOT_FOUND, 'No active risk action with that id');
    await this.prisma.$transaction((tx) => this.liftInTx(tx, a, actor.userId, reason));
    await this.audit.record({ action: 'risk.action.lifted', resourceType: 'merchant', resourceId: a.merchantId, organizationId: a.merchantId, metadata: { action_id: id, type: a.type, reason, severity: 'HIGH' } });
    return presentRiskAction(await this.prisma.riskActionRecord.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * Undo one action. Several events can stack the same control on a merchant: the control only
   * comes off when the last of them is lifted, and the "was it on before?" fact moves to a survivor.
   */
  private async liftInTx(tx: TransactionClient, a: RiskActionRecord, actorId: string, reason: string): Promise<void> {
    const res = await tx.riskActionRecord.updateMany({ where: { id: a.id, active: true }, data: { active: false, liftedById: actorId, liftedAt: new Date(), liftReason: reason.slice(0, 300) } });
    if (res.count !== 1) return;
    const survivor = await tx.riskActionRecord.findFirst({ where: { merchantId: a.merchantId, type: a.type, active: true }, orderBy: { createdAt: 'asc' } });
    if (a.type === 'HOLD_SETTLEMENT') {
      if (!a.holdId) return;
      if (survivor) {
        await tx.riskActionRecord.update({ where: { id: survivor.id }, data: { holdId: a.holdId } });
        return;
      }
      await tx.settlementHold.updateMany({ where: { id: a.holdId, releasedAt: null }, data: { releasedAt: new Date(), releasedById: actorId, releaseReason: `Risk action lifted: ${reason}`.slice(0, 300) } });
      return;
    }
    if (a.type === 'DISABLE_PAYIN' || a.type === 'DISABLE_PAYOUT') {
      if (!a.previousValue) return;
      if (survivor) {
        await tx.riskActionRecord.update({ where: { id: survivor.id }, data: { previousValue: true } });
        return;
      }
      const field = a.type === 'DISABLE_PAYIN' ? 'payinEnabled' : 'payoutEnabled';
      await tx.merchant.update({ where: { id: a.merchantId }, data: { [field]: true, version: { increment: 1 } } });
    }
  }
}
