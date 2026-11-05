import { Inject, Injectable } from '@nestjs/common';
import type { AgentPlanCode, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { agentAdminListQuerySchema, agentAdminStatusSchema, agentPlanUpdateSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { SessionService } from '../auth/session.service';
import { istMonthStart, money, platformOnly, presentPlan } from './agent-common';
import { AgentPlansService } from './agent-plans.service';

/** Platform staff view of the agent program (Admin → Agents). */
@Injectable()
export class AgentAdminService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly plans: AgentPlansService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async overview(actor: Actor) {
    platformOnly(actor);
    const month = istMonthStart();
    const [byPlan, total, newThisMonth, txns, paid] = await Promise.all([
      this.prisma.agentProfile.groupBy({ by: ['planId'], _count: true }),
      this.prisma.agentProfile.count(),
      this.prisma.agentProfile.count({ where: { createdAt: { gte: month } } }),
      this.prisma.agentTransaction.aggregate({ where: { createdAt: { gte: month } }, _count: true, _sum: { amountMinor: true } }),
      this.prisma.agentPlanOrder.aggregate({ where: { status: 'PAID', grantedById: null, paidAt: { gte: month } }, _count: true, _sum: { amountMinor: true } }),
    ]);
    const plans = await this.prisma.agentPlan.findMany({ orderBy: { sortOrder: 'asc' } });
    return {
      agents: total,
      new_this_month: newThisMonth,
      by_plan: plans.map((p) => ({ code: p.code, name: p.name, agents: byPlan.find((b) => b.planId === p.id)?._count ?? 0 })),
      transactions_this_month: txns._count,
      volume_this_month: money(txns._sum.amountMinor),
      plan_revenue_this_month: money(paid._sum.amountMinor),
      plan_orders_this_month: paid._count,
    };
  }

  async list(actor: Actor, q: z.output<typeof agentAdminListQuerySchema>) {
    platformOnly(actor);
    const s = q.search?.trim();
    const rows = await this.prisma.agentProfile.findMany({
      where: {
        AND: [
          q.plan ? { plan: { code: q.plan } } : {},
          s ? { OR: [{ shopName: { contains: s, mode: 'insensitive' } }, { ownerName: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }, { mobile: { contains: s } }] } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      include: { plan: true, organization: { select: { status: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const month = istMonthStart();
    const counts = await this.prisma.agentTransaction.groupBy({ by: ['agentId'], where: { agentId: { in: rows.map((r) => r.id) }, createdAt: { gte: month } }, _count: true });
    return toPage(rows, q.limit, (p) => {
      const lapsed = p.plan.code !== 'FREE' && (!p.planExpiresAt || p.planExpiresAt.getTime() < Date.now());
      return {
        id: p.id,
        shop_name: p.shopName,
        owner_name: p.ownerName,
        email: p.email,
        mobile: p.mobile,
        city: p.city,
        status: p.organization.status,
        plan_code: lapsed ? 'FREE' : p.plan.code,
        subscribed_plan_code: p.plan.code,
        plan_expires_at: p.planExpiresAt,
        transactions_this_month: counts.find((c) => c.agentId === p.id)?._count ?? 0,
        created_at: p.createdAt,
      };
    });
  }

  async get(actor: Actor, agentId: string) {
    platformOnly(actor);
    const p = await this.prisma.agentProfile.findUnique({ where: { id: agentId }, include: { organization: { select: { status: true, parentId: true } } } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
    const [eff, usage, orders, totals, drive] = await Promise.all([
      this.plans.effective(agentId),
      this.plans.usage(agentId),
      this.prisma.agentPlanOrder.findMany({ where: { agentId }, include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.agentTransaction.aggregate({ where: { agentId }, _count: true, _sum: { amountMinor: true, feeMinor: true } }),
      this.prisma.agentDriveConnection.findUnique({ where: { agentId }, select: { lastBackupAt: true, status: true } }),
    ]);
    return {
      id: p.id,
      shop_name: p.shopName,
      owner_name: p.ownerName,
      email: p.email,
      mobile: p.mobile,
      address: [p.addressLine, p.city, p.state, p.pincode].filter(Boolean).join(', ') || null,
      upi_vpa: p.upiVpa,
      status: p.organization.status,
      plan: { ...presentPlan(eff.plan), expires_at: eff.lapsed ? null : eff.expiresAt, lapsed_from: eff.lapsed ? eff.subscribed.code : null },
      usage,
      lifetime: { transactions: totals._count, volume: money(totals._sum.amountMinor), fees: money(totals._sum.feeMinor) },
      drive: drive ? { status: drive.status, last_backup_at: drive.lastBackupAt } : null,
      orders: orders.map((o) => ({ id: o.id, plan_code: o.plan.code, period: o.period, amount: money(o.amountMinor), status: o.status, granted: Boolean(o.grantedById), period_end: o.periodEnd, paid_at: o.paidAt, created_at: o.createdAt })),
      created_at: p.createdAt,
    };
  }

  async setStatus(actor: Actor, agentId: string, input: z.output<typeof agentAdminStatusSchema>) {
    platformOnly(actor);
    const org = await this.prisma.organization.findFirst({ where: { id: agentId, type: 'AGENT' } });
    if (!org) throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
    if (input.status === 'SUSPENDED' && !input.reason) throw new AppError(ErrorCode.INVALID_REQUEST, 'Say why the agent is suspended', [{ path: 'reason', message: 'Required' }]);
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: agentId }, data: { status: input.status } });
      await this.audit.record({ action: input.status === 'SUSPENDED' ? 'agent.suspended' : 'agent.reactivated', resourceType: 'agent', resourceId: agentId, organizationId: agentId, oldValue: { status: org.status }, newValue: { status: input.status }, metadata: { reason: input.reason } }, tx);
    });
    if (input.status === 'SUSPENDED') {
      const members = await this.prisma.userRole.findMany({ where: { organizationId: agentId }, select: { userId: true } });
      for (const m of members) await this.sessions.revokeAllForUser(m.userId, 'ADMIN_REVOKED');
    }
    return this.get(actor, agentId);
  }

  async plansList(actor: Actor) {
    platformOnly(actor);
    return this.plans.catalog(true);
  }

  async updatePlan(actor: Actor, code: AgentPlanCode, input: z.output<typeof agentPlanUpdateSchema>) {
    platformOnly(actor);
    const before = await this.plans.byCode(code);
    if (code === 'FREE' && (input.price_monthly || input.price_yearly)) throw new AppError(ErrorCode.INVALID_REQUEST, 'The Free plan has no price');
    if (code === 'FREE' && input.active === false) throw new AppError(ErrorCode.INVALID_REQUEST, 'The Free plan cannot be switched off; agents fall back to it');
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await tx.agentPlan.update({
        where: { code },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.price_monthly !== undefined ? { priceMonthlyMinor: input.price_monthly } : {}),
          ...(input.price_yearly !== undefined ? { priceYearlyMinor: input.price_yearly } : {}),
          ...(input.monthly_txn_limit !== undefined ? { monthlyTxnLimit: input.monthly_txn_limit } : {}),
          ...(input.staff_limit !== undefined ? { staffLimit: input.staff_limit } : {}),
          ...(input.drive_backup !== undefined ? { driveBackup: input.drive_backup } : {}),
          ...(input.branded_receipts !== undefined ? { brandedReceipts: input.branded_receipts } : {}),
          ...(input.messaging !== undefined ? { messaging: input.messaging } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      await this.audit.record({ action: 'agent.plan.updated', resourceType: 'agent_plan', resourceId: p.id, oldValue: presentPlan(before), newValue: presentPlan(p) }, tx);
      return p;
    });
    return presentPlan(after);
  }
}
