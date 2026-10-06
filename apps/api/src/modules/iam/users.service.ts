import { Inject, Injectable } from '@nestjs/common';
import { generateToken, hashPassword, newId, type PermissionKey } from '@pay2all/auth';
import { isUniqueViolation, type OrganizationType, type Prisma, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { assignRoleSchema, createUserSchema, listUsersQuerySchema, updateUserStatusSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { MailService } from '../../infra/mail.service';
import { PRISMA } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { INVITE_TOKEN_TTL_MS, PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';

const userSelect = (orgIds: string[] | null) =>
  ({
    id: true,
    name: true,
    email: true,
    mobile: true,
    status: true,
    lastLoginAt: true,
    lockedUntil: true,
    createdAt: true,
    memberships: {
      where: orgIds ? { organizationId: { in: orgIds } } : {},
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        organization: { select: { id: true, name: true, type: true } },
        role: { select: { key: true, name: true } },
      },
    },
  }) satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: ReturnType<typeof userSelect> }>;

function maskMobile(mobile: string | null): string | null {
  return mobile ? `${mobile.slice(0, 3)}******${mobile.slice(-4)}` : null;
}

export function presentUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    mobile: maskMobile(u.mobile),
    status: u.status,
    locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()),
    last_login_at: u.lastLoginAt,
    created_at: u.createdAt,
    memberships: u.memberships.map((m) => ({
      organization_id: m.organization.id,
      organization_name: m.organization.name,
      organization_type: m.organization.type,
      role_key: m.role.key,
      role_name: m.role.name,
      granted_at: m.createdAt,
    })),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly profiles: AccessProfileService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** Resolve which org ids to filter by; a requested org must be in scope. */
  private async resolveOrgFilter(actor: Actor, organizationId?: string): Promise<string[] | null> {
    if (organizationId) {
      await this.scope.requireOrganization(actor, organizationId);
      return [organizationId];
    }
    return this.scope.accessibleOrganizationIds(actor);
  }

  async list(actor: Actor, query: z.output<typeof listUsersQuerySchema>) {
    const orgIds = await this.resolveOrgFilter(actor, query.organization_id);
    const rows = await this.prisma.user.findMany({
      where: {
        AND: [
          orgIds ? { memberships: { some: { organizationId: { in: orgIds } } } } : {},
          query.status ? { status: query.status } : {},
          query.search
            ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { email: { contains: query.search.toLowerCase() } }] }
            : {},
          keysetAfter(decodeCursor(query.cursor)),
        ],
      },
      select: userSelect(orgIds),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, presentUser);
  }

  async get(actor: Actor, userId: string) {
    return presentUser(await this.findInScope(actor, userId));
  }

  private async findInScope(actor: Actor, userId: string): Promise<UserRow> {
    const orgIds = await this.scope.accessibleOrganizationIds(actor);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, ...(orgIds ? { memberships: { some: { organizationId: { in: orgIds } } } } : {}) },
      select: userSelect(orgIds),
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
    return user;
  }

  /** Role must fit the org type and grant nothing the actor doesn't already hold (no escalation). */
  private async resolveGrantableRole(actor: Actor, roleKey: string, org: { id: string; type: OrganizationType }) {
    const role = await this.prisma.role.findFirst({
      where: { key: roleKey, scope: org.type, OR: [{ organizationId: null }, { organizationId: org.id }] },
      select: { id: true, key: true, permissions: { select: { permissionKey: true } } },
    });
    if (!role) throw new AppError(ErrorCode.INVALID_REQUEST, `Role ${roleKey} cannot be granted in this organization`);
    const escalates = role.permissions.some((p) => !actor.permissions.has(p.permissionKey as PermissionKey));
    if (escalates) throw new AppError(ErrorCode.FORBIDDEN, 'You cannot grant a role with permissions you do not hold');
    return role;
  }

  /**
   * Invite a user into an organization. New emails get an INVITED account + set-password link; an
   * existing account simply gains the membership. The response is identical either way so the
   * endpoint can't be used to probe which emails are registered.
   */
  async create(actor: Actor, input: z.output<typeof createUserSchema>) {
    const org = await this.scope.requireOrganization(actor, input.organization_id ?? actor.organizationId);
    const role = await this.resolveGrantableRole(actor, input.role_key, org);

    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    let userId = existing?.id;
    let inviteToken: string | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (!userId) {
          userId = newId('user');
          await tx.user.create({
            data: {
              id: userId,
              name: input.name,
              email: input.email,
              mobile: input.mobile ?? null,
              status: 'INVITED',
              // Unusable random password until the invitation is accepted.
              passwordHash: await hashPassword(generateToken(32)),
              createdById: actor.userId,
            },
          });
          await this.audit.record({ action: 'user.invited', resourceType: 'user', resourceId: userId, organizationId: org.id, newValue: { email: input.email, name: input.name } }, tx);
        }
        await tx.userRole.create({
          data: { id: newId('membership'), userId, roleId: role.id, organizationId: org.id, grantedById: actor.userId },
        });
        await this.audit.record({ action: 'role.granted', resourceType: 'user', resourceId: userId, organizationId: org.id, newValue: { role: role.key } }, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'mobile')) throw new AppError(ErrorCode.CONFLICT, 'Mobile number is already in use');
      // A concurrent invite created the same email first — our transaction rolled back; ask to retry.
      if (isUniqueViolation(err) && !existing) throw new AppError(ErrorCode.CONFLICT, 'Please retry the request');
      if (!isUniqueViolation(err)) throw err; // membership already exists → idempotent success
    }

    if (!existing && userId) {
      inviteToken = await this.passwords.issueToken(userId, INVITE_TOKEN_TTL_MS);
      this.mail.sendInBackground({
        to: input.email,
        subject: `You've been invited to ${org.name} on Pay2All`,
        text: `Hi ${input.name},\n\nYou've been invited to join ${org.name} on Pay2All Payments. Set your password within 72 hours:\n${this.passwords.link('/reset-password', inviteToken)}\n`,
      });
    } else {
      this.mail.sendInBackground({
        to: input.email,
        subject: `You've been added to ${org.name} on Pay2All`,
        text: `You now have access to ${org.name} on Pay2All Payments.`,
      });
    }
    if (userId) await this.profiles.invalidateUser(userId);
    return { invited: true, organization_id: org.id, role_key: role.key, email: input.email };
  }

  /** Global account status — platform staff only, because a user may belong to several tenants. */
  async updateStatus(actor: Actor, userId: string, input: z.output<typeof updateUserStatusSchema>) {
    if (actor.organizationType !== 'PLATFORM') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Remove the user from your organization instead');
    }
    if (userId === actor.userId) throw new AppError(ErrorCode.FORBIDDEN, 'You cannot change your own status');
    const user = await this.findInScope(actor, userId);
    if (user.status === input.status) return presentUser(user);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: input.status, ...(input.status === 'ACTIVE' ? { lockedUntil: null, failedLoginCount: 0 } : {}) },
      });
      await this.audit.record(
        { action: input.status === 'DISABLED' ? 'user.disabled' : 'user.enabled', resourceType: 'user', resourceId: userId, oldValue: { status: user.status }, newValue: { status: input.status }, metadata: { reason: input.reason } },
        tx,
      );
    });
    if (input.status === 'DISABLED') await this.sessions.revokeAllForUser(userId, 'USER_DISABLED');
    await this.profiles.invalidateUser(userId);
    return this.get(actor, userId);
  }

  async assignRole(actor: Actor, userId: string, input: z.output<typeof assignRoleSchema>) {
    const org = await this.scope.requireOrganization(actor, input.organization_id ?? actor.organizationId);
    await this.findInScope(actor, userId);
    const isMember = await this.prisma.userRole.count({ where: { userId, organizationId: org.id } });
    if (!isMember) throw new AppError(ErrorCode.NOT_FOUND, 'User is not a member of this organization');
    const role = await this.resolveGrantableRole(actor, input.role_key, org);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userRole.create({ data: { id: newId('membership'), userId, roleId: role.id, organizationId: org.id, grantedById: actor.userId } });
        await this.audit.record({ action: 'role.granted', resourceType: 'user', resourceId: userId, organizationId: org.id, newValue: { role: role.key } }, tx);
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    await this.profiles.invalidateUser(userId);
    return this.get(actor, userId);
  }

  async revokeRole(actor: Actor, userId: string, roleKey: string, organizationId?: string) {
    if (userId === actor.userId) throw new AppError(ErrorCode.FORBIDDEN, 'You cannot change your own roles');
    const org = await this.scope.requireOrganization(actor, organizationId ?? actor.organizationId);
    await this.findInScope(actor, userId);

    const membership = await this.prisma.userRole.findFirst({
      where: { userId, organizationId: org.id, role: { key: roleKey } },
      select: { id: true, role: { select: { key: true, permissions: { select: { permissionKey: true } } } } },
    });
    if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Role assignment not found');
    if (membership.role.permissions.some((p) => !actor.permissions.has(p.permissionKey as PermissionKey))) {
      throw new AppError(ErrorCode.FORBIDDEN, 'You cannot remove a role with permissions you do not hold');
    }
    if (roleKey === 'MERCHANT_OWNER') {
      const owners = await this.prisma.userRole.count({ where: { organizationId: org.id, role: { key: 'MERCHANT_OWNER' } } });
      if (owners <= 1) throw new AppError(ErrorCode.FORBIDDEN, 'An organization must keep at least one owner');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({ where: { id: membership.id } });
      await this.audit.record({ action: 'role.revoked', resourceType: 'user', resourceId: userId, organizationId: org.id, oldValue: { role: roleKey } }, tx);
    });
    await this.profiles.invalidateUser(userId);
    return { revoked: true };
  }
}
