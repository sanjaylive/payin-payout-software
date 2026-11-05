import { Inject, Injectable } from '@nestjs/common';
import { checkPasswordPolicy, hashPassword, newId } from '@pay2all/auth';
import { isUniqueViolation, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { agentStaffCreateSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { SessionService } from '../auth/session.service';
import { agentOnly } from './agent-common';
import { AgentPlansService } from './agent-plans.service';

/**
 * Counter operators (docs/AGENTS.md §6). The owner creates their logins with a starting password;
 * the plan caps how many active logins an agent has (owner included).
 */
@Injectable()
export class AgentStaffService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly plans: AgentPlansService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor) {
    const agentId = agentOnly(actor);
    const [members, eff] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { organizationId: agentId },
        include: { user: { select: { id: true, name: true, email: true, mobile: true, status: true, lastLoginAt: true } }, role: { select: { key: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.plans.effective(agentId),
    ]);
    const active = members.filter((m) => m.user.status !== 'DISABLED').length;
    return {
      staff_limit: eff.plan.staffLimit,
      active,
      members: members.map((m) => ({
        user_id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        mobile: m.user.mobile,
        role: m.role.key,
        role_name: m.role.name,
        active: m.user.status !== 'DISABLED',
        last_login_at: m.user.lastLoginAt,
        is_you: m.user.id === actor.userId,
      })),
    };
  }

  async create(actor: Actor, input: z.output<typeof agentStaffCreateSchema>) {
    const agentId = agentOnly(actor);
    const issues = checkPasswordPolicy(input.password, { email: input.email, mobile: input.mobile });
    if (issues.length) throw new AppError(ErrorCode.PASSWORD_POLICY_VIOLATION, 'Password does not meet the policy', issues.map((message) => ({ path: 'password', message })));
    const role = await this.prisma.role.findFirstOrThrow({ where: { key: 'AGENT_OPERATOR', organizationId: null }, select: { id: true } });
    const passwordHash = await hashPassword(input.password);
    const userId = newId('user');
    try {
      await this.prisma.$transaction(async (tx) => {
        // Lock the agent's row so two concurrent invites cannot both pass the limit check.
        await tx.agentProfile.update({ where: { id: agentId }, data: { updatedAt: new Date() } });
        const { plan } = await this.plans.effective(agentId, tx);
        if ((await this.plans.activeStaffCount(agentId, tx)) >= plan.staffLimit) {
          throw new AppError(ErrorCode.LIMIT_EXCEEDED, `Your ${plan.name} plan allows ${plan.staffLimit} login${plan.staffLimit === 1 ? '' : 's'}. Upgrade to add more staff.`);
        }
        await tx.user.create({ data: { id: userId, name: input.name, email: input.email, mobile: input.mobile, passwordHash, status: 'ACTIVE', createdById: actor.userId } });
        await tx.userRole.create({ data: { id: newId('membership'), userId, roleId: role.id, organizationId: agentId, grantedById: actor.userId } });
        await this.audit.record({ action: 'agent.staff.created', resourceType: 'user', resourceId: userId, organizationId: agentId, newValue: { role: 'AGENT_OPERATOR' } }, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'email')) throw new AppError(ErrorCode.CONFLICT, 'This email already has an account', [{ path: 'email', message: 'Already registered' }]);
      if (isUniqueViolation(err, 'mobile')) throw new AppError(ErrorCode.CONFLICT, 'This mobile number already has an account', [{ path: 'mobile', message: 'Already registered' }]);
      throw err;
    }
    return this.list(actor);
  }

  async setActive(actor: Actor, userId: string, active: boolean) {
    const agentId = agentOnly(actor);
    if (userId === actor.userId) throw new AppError(ErrorCode.INVALID_REQUEST, 'You cannot change your own login');
    const m = await this.prisma.userRole.findFirst({ where: { organizationId: agentId, userId }, include: { role: { select: { key: true } } } });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, 'Staff member not found');
    if (m.role.key !== 'AGENT_OPERATOR') throw new AppError(ErrorCode.FORBIDDEN, 'Only counter operators can be changed here');
    // Operator logins created here belong to this agent only; never touch a user with other memberships.
    if ((await this.prisma.userRole.count({ where: { userId } })) !== 1) throw new AppError(ErrorCode.FORBIDDEN, 'This login is shared with another account');
    await this.prisma.$transaction(async (tx) => {
      if (active) {
        await tx.agentProfile.update({ where: { id: agentId }, data: { updatedAt: new Date() } });
        const { plan } = await this.plans.effective(agentId, tx);
        if ((await this.plans.activeStaffCount(agentId, tx)) >= plan.staffLimit) throw new AppError(ErrorCode.LIMIT_EXCEEDED, `Your ${plan.name} plan allows ${plan.staffLimit} logins.`);
      }
      await tx.user.update({ where: { id: userId }, data: { status: active ? 'ACTIVE' : 'DISABLED' } });
      await this.audit.record({ action: active ? 'agent.staff.enabled' : 'agent.staff.disabled', resourceType: 'user', resourceId: userId, organizationId: agentId }, tx);
    });
    if (!active) await this.sessions.revokeAllForUser(userId, 'USER_DISABLED');
    return this.list(actor);
  }
}
