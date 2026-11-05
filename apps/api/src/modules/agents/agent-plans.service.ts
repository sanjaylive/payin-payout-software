import { Inject, Injectable } from '@nestjs/common';
import type { AgentPlan, AgentPlanCode, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { istMonthStart, presentPlan } from './agent-common';

type Db = PrismaClient | Prisma.TransactionClient;

export interface EffectivePlan {
  plan: AgentPlan;
  /** The plan the agent paid for, even if it has lapsed (then `plan` is Free). */
  subscribed: AgentPlan;
  expiresAt: Date | null;
  lapsed: boolean;
}

/**
 * Plan catalog and plan rules (docs/AGENTS.md §2). A paid plan applies until plan_expires_at; after
 * that the agent is treated as Free until they pay again. Nothing is deleted when a plan lapses.
 */
@Injectable()
export class AgentPlansService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async catalog(includeInactive = false) {
    const plans = await this.prisma.agentPlan.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { sortOrder: 'asc' } });
    return plans.map(presentPlan);
  }

  byCode(code: AgentPlanCode, db: Db = this.prisma) {
    return db.agentPlan.findUniqueOrThrow({ where: { code } });
  }

  async effective(agentId: string, db: Db = this.prisma): Promise<EffectivePlan> {
    const profile = await db.agentProfile.findUnique({ where: { id: agentId }, include: { plan: true } });
    if (!profile) throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
    const lapsed = profile.plan.code !== 'FREE' && (!profile.planExpiresAt || profile.planExpiresAt.getTime() < Date.now());
    return { plan: lapsed ? await this.byCode('FREE', db) : profile.plan, subscribed: profile.plan, expiresAt: profile.planExpiresAt, lapsed };
  }

  async usage(agentId: string, db: Db = this.prisma) {
    const [transactions, staff] = await Promise.all([
      db.agentTransaction.count({ where: { agentId, createdAt: { gte: istMonthStart() } } }),
      this.activeStaffCount(agentId, db),
    ]);
    return { transactions_this_month: transactions, staff };
  }

  activeStaffCount(agentId: string, db: Db = this.prisma) {
    return db.userRole.count({ where: { organizationId: agentId, user: { status: { not: 'DISABLED' } } } });
  }

  /** Refuse a new transaction once this month's allowance is used. Call inside the creating transaction. */
  async assertCanRecord(agentId: string, db: Db) {
    const { plan } = await this.effective(agentId, db);
    if (plan.monthlyTxnLimit === null) return;
    const used = await db.agentTransaction.count({ where: { agentId, createdAt: { gte: istMonthStart() } } });
    if (used >= plan.monthlyTxnLimit) {
      throw new AppError(ErrorCode.LIMIT_EXCEEDED, `Your ${plan.name} plan allows ${plan.monthlyTxnLimit} transactions a month. Upgrade to record more.`);
    }
  }

  async assertFeature(agentId: string, feature: 'driveBackup' | 'brandedReceipts' | 'messaging', label: string) {
    const { plan } = await this.effective(agentId);
    if (!plan[feature]) throw new AppError(ErrorCode.FORBIDDEN, `${label} is not part of the ${plan.name} plan. Upgrade to use it.`);
  }
}
