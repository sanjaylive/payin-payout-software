import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { AgentPlanOrder, AgentPlan, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { agentCheckoutSchema, agentGrantPlanSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { BrandService } from '../../infra/brand.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { agentOnly, istDate, money, platformOnly, presentPlan } from './agent-common';
import { AgentPlansService } from './agent-plans.service';

const ORDER_TTL_MS = 24 * 3600_000;

function addPeriod(from: Date, period: 'MONTHLY' | 'YEARLY'): Date {
  const d = new Date(from);
  if (period === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * Plan billing (docs/AGENTS.md §2.2). Each purchase is an order paid through a payment link on the
 * platform's own billing merchant (Admin → Agents → Settings), so it uses the platform's gateways and
 * hosted checkout. When the link is paid the order activates: renewing the same plan extends it from
 * its current end; switching plan starts the new period now.
 */
@Injectable()
export class AgentBillingService {
  private readonly logger = new Logger(AgentBillingService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly plans: AgentPlansService,
    private readonly brand: BrandService,
    private readonly audit: AuditService,
  ) {}

  private presentOrder(o: AgentPlanOrder & { plan: AgentPlan }) {
    return {
      id: o.id,
      plan_code: o.plan.code,
      plan_name: o.plan.name,
      period: o.period,
      amount: money(o.amountMinor),
      status: o.status,
      checkout_url: o.status === 'PENDING' ? o.checkoutUrl : null,
      period_start: o.periodStart,
      period_end: o.periodEnd,
      paid_at: o.paidAt,
      granted: Boolean(o.grantedById),
      created_at: o.createdAt,
    };
  }

  /** The billing merchant, if one is set and can collect. */
  private async billingMerchant(): Promise<string | null> {
    const s = await this.prisma.agentProgramSettings.findUnique({ where: { id: 'default' } });
    if (!s?.billingMerchantId) return null;
    const m = await this.prisma.merchant.findUnique({ where: { id: s.billingMerchantId }, select: { status: true, payinEnabled: true } });
    return m?.status === 'APPROVED' && m.payinEnabled ? s.billingMerchantId : null;
  }

  async overview(actor: Actor) {
    const agentId = agentOnly(actor);
    const [eff, usage, catalog, orders, billing] = await Promise.all([
      this.plans.effective(agentId),
      this.plans.usage(agentId),
      this.plans.catalog(),
      this.prisma.agentPlanOrder.findMany({ where: { agentId }, include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 24 }),
      this.billingMerchant(),
    ]);
    return {
      current: { ...presentPlan(eff.plan), expires_at: eff.lapsed ? null : eff.expiresAt, lapsed_from: eff.lapsed ? eff.subscribed.code : null },
      usage,
      plans: catalog,
      online_payment_available: Boolean(billing),
      orders: orders.map((o) => this.presentOrder(o)),
    };
  }

  async checkout(actor: Actor, input: z.output<typeof agentCheckoutSchema>) {
    const agentId = agentOnly(actor);
    const merchantId = await this.billingMerchant();
    if (!merchantId) throw new AppError(ErrorCode.INVALID_REQUEST, 'Online payment for plans is not available yet. Contact support to upgrade.');
    const plan = await this.plans.byCode(input.plan_code);
    if (!plan.active) throw new AppError(ErrorCode.INVALID_REQUEST, 'This plan is not available');
    const amount = input.period === 'YEARLY' ? plan.priceYearlyMinor : plan.priceMonthlyMinor;
    if (amount < 100n) throw new AppError(ErrorCode.INVALID_REQUEST, 'This plan has no price set. Contact support.');

    // Reuse an open order for the same choice rather than piling up links.
    const open = await this.prisma.agentPlanOrder.findFirst({
      where: { agentId, planId: plan.id, period: input.period, status: 'PENDING', amountMinor: amount, createdAt: { gt: new Date(Date.now() - ORDER_TTL_MS + 3600_000) } },
      include: { plan: true },
    });
    if (open) return this.presentOrder(open);

    const profile = await this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId } });
    const id = newId('agentPlanOrder');
    const sessionId = newId('checkoutSession');
    const token = randomBytes(24).toString('base64url');
    const url = `${await this.brand.webBase(merchantId)}/checkout/${token}`;
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.checkoutSession.create({
        data: {
          id: sessionId,
          merchantId,
          kind: 'LINK',
          token,
          merchantOrderId: `AGP-${id.slice(4)}`,
          amountMinor: amount,
          description: `${plan.name} plan (${input.period === 'YEARLY' ? '1 year' : '1 month'}) for ${profile.shopName}`,
          customerName: profile.ownerName,
          customerEmail: profile.email,
          customerMobile: profile.mobile,
          metadata: { purpose: 'agent_plan', agent_id: agentId, order_id: id },
          expiresAt: new Date(Date.now() + ORDER_TTL_MS),
          createdById: actor.userId,
        },
      });
      const created = await tx.agentPlanOrder.create({
        data: { id, agentId, planId: plan.id, period: input.period, amountMinor: amount, checkoutSessionId: sessionId, checkoutUrl: url, createdById: actor.userId },
        include: { plan: true },
      });
      await this.audit.record({ action: 'agent.plan.checkout_started', resourceType: 'agent_plan_order', resourceId: id, organizationId: agentId, newValue: { plan: plan.code, period: input.period, amount: money(amount) } }, tx);
      return created;
    });
    return this.presentOrder(order);
  }

  async getOrder(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const o = await this.prisma.agentPlanOrder.findFirst({ where: { id, agentId } });
    if (!o) throw new AppError(ErrorCode.NOT_FOUND, 'Order not found');
    if (o.status === 'PENDING') await this.sync(o.id);
    return this.presentOrder(await this.prisma.agentPlanOrder.findUniqueOrThrow({ where: { id }, include: { plan: true } }));
  }

  async cancelOrder(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const o = await this.prisma.agentPlanOrder.findFirst({ where: { id, agentId, status: 'PENDING' } });
    if (!o) throw new AppError(ErrorCode.NOT_FOUND, 'No open order');
    await this.sync(o.id);
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.agentPlanOrder.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (n.count && o.checkoutSessionId) await tx.checkoutSession.updateMany({ where: { id: o.checkoutSessionId, status: 'OPEN', paymentId: null }, data: { status: 'CANCELLED' } });
    });
    return this.getOrder(actor, id);
  }

  /** Bring one PENDING order in line with its payment link. Safe to call repeatedly and concurrently. */
  async sync(orderId: string): Promise<void> {
    const o = await this.prisma.agentPlanOrder.findUnique({ where: { id: orderId } });
    if (!o || o.status !== 'PENDING' || !o.checkoutSessionId) return;
    const s = await this.prisma.checkoutSession.findUnique({ where: { id: o.checkoutSessionId }, select: { status: true, expiresAt: true, paidAt: true } });
    if (!s) return;
    if (s.status === 'PAID') {
      await this.activate(o.id, s.paidAt ?? new Date(), null);
      return;
    }
    const dead = s.status === 'EXPIRED' || s.status === 'CANCELLED' || (s.status === 'OPEN' && s.expiresAt.getTime() < Date.now() - 3600_000);
    if (dead) await this.prisma.agentPlanOrder.updateMany({ where: { id: o.id, status: 'PENDING' }, data: { status: s.status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED' } });
  }

  /** Jobs: settle every recent open order (payments arrive by webhook or poller, not through us). */
  async syncPending(): Promise<number> {
    const open = await this.prisma.agentPlanOrder.findMany({ where: { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 3 * ORDER_TTL_MS) } }, select: { id: true }, take: 500 });
    for (const o of open) {
      try {
        await this.sync(o.id);
      } catch (err) {
        this.logger.error({ err, order: o.id }, 'Agent plan order sync failed');
      }
    }
    const stale = await this.prisma.agentPlanOrder.updateMany({ where: { status: 'PENDING', createdAt: { lte: new Date(Date.now() - 3 * ORDER_TTL_MS) } }, data: { status: 'EXPIRED' } });
    return open.length + stale.count;
  }

  /** Mark an order paid and move the agent's plan. `grantedEnd` is set for admin grants. */
  private async activate(orderId: string, paidAt: Date, grantedEnd: Date | null) {
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.agentPlanOrder.findUniqueOrThrow({ where: { id: orderId } });
      const profile = await tx.agentProfile.update({ where: { id: o.agentId }, data: { updatedAt: new Date() }, include: { plan: true } });
      if (o.status !== 'PENDING') return;
      const now = new Date();
      const sameActive = profile.planId === o.planId && profile.planExpiresAt && profile.planExpiresAt > now;
      const start = sameActive ? profile.planExpiresAt! : now;
      const end = grantedEnd ?? addPeriod(start, o.period);
      await tx.agentPlanOrder.update({ where: { id: o.id }, data: { status: 'PAID', paidAt, periodStart: start, periodEnd: end } });
      await tx.agentProfile.update({ where: { id: o.agentId }, data: { planId: o.planId, planExpiresAt: end } });
      await this.audit.record(
        {
          action: o.grantedById ? 'agent.plan.granted' : 'agent.plan.paid',
          resourceType: 'agent_plan_order',
          resourceId: o.id,
          organizationId: o.agentId,
          actor: o.grantedById ? undefined : { type: 'SYSTEM', id: null },
          oldValue: { plan_id: profile.planId, expires_at: profile.planExpiresAt },
          newValue: { plan_id: o.planId, expires_at: end },
        },
        tx,
      );
    });
  }

  // ---- Platform admin -----------------------------------------------------------------------------

  async grant(actor: Actor, agentId: string, input: z.output<typeof agentGrantPlanSchema>) {
    platformOnly(actor);
    const profile = await this.prisma.agentProfile.findUnique({ where: { id: agentId } });
    if (!profile) throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
    const plan = await this.plans.byCode(input.plan_code);
    if (plan.code === 'FREE') {
      await this.prisma.$transaction(async (tx) => {
        await tx.agentProfile.update({ where: { id: agentId }, data: { planId: plan.id, planExpiresAt: null } });
        await this.audit.record({ action: 'agent.plan.reset_to_free', resourceType: 'agent', resourceId: agentId, organizationId: agentId, metadata: { note: input.note } }, tx);
      });
      return { plan_code: 'FREE', expires_at: null };
    }
    if (!input.expires_at) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose until when the plan applies', [{ path: 'expires_at', message: 'Required' }]);
    // The plan runs to the end of the chosen IST day.
    const end = new Date(istDate(input.expires_at).getTime() + 86_400_000 - 1);
    if (end.getTime() <= Date.now()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose a future date', [{ path: 'expires_at', message: 'In the past' }]);
    const id = newId('agentPlanOrder');
    await this.prisma.agentPlanOrder.create({ data: { id, agentId, planId: plan.id, period: 'MONTHLY', amountMinor: 0n, grantedById: actor.userId, createdById: actor.userId } });
    await this.activate(id, new Date(), end);
    return { plan_code: plan.code, expires_at: end };
  }

  async settings(actor: Actor) {
    platformOnly(actor);
    const s = await this.prisma.agentProgramSettings.findUnique({ where: { id: 'default' } });
    const m = s?.billingMerchantId ? await this.prisma.merchant.findUnique({ where: { id: s.billingMerchantId }, select: { status: true, payinEnabled: true, organization: { select: { name: true } } } }) : null;
    return {
      billing_merchant_id: s?.billingMerchantId ?? null,
      billing_merchant_name: m?.organization.name ?? null,
      billing_ready: Boolean(m && m.status === 'APPROVED' && m.payinEnabled),
    };
  }

  async updateSettings(actor: Actor, billingMerchantId: string | null) {
    platformOnly(actor);
    if (billingMerchantId) {
      const m = await this.prisma.merchant.findUnique({ where: { id: billingMerchantId }, select: { status: true, payinEnabled: true } });
      if (!m) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found', [{ path: 'billing_merchant_id', message: 'Not found' }]);
      if (m.status !== 'APPROVED' || !m.payinEnabled) throw new AppError(ErrorCode.INVALID_REQUEST, 'The billing merchant must be approved with collections enabled', [{ path: 'billing_merchant_id', message: 'Cannot collect' }]);
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.agentProgramSettings.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} });
      await tx.agentProgramSettings.update({ where: { id: 'default' }, data: { billingMerchantId, updatedById: actor.userId } });
      await this.audit.record({ action: 'agent.settings.updated', resourceType: 'agent_program_settings', resourceId: 'default', oldValue: { billing_merchant_id: before.billingMerchantId }, newValue: { billing_merchant_id: billingMerchantId } }, tx);
    });
    return this.settings(actor);
  }
}
