import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import type { Actor } from '../auth/actor';

export type TenantScope =
  | { kind: 'ALL' }
  | { kind: 'RESELLER'; resellerOrgId: string }
  | { kind: 'ORG'; orgId: string };

/**
 * Computes which organizations an actor may see (docs/SECURITY.md §3). Every query on tenant-owned
 * data composes these fragments. Out-of-scope lookups return NOT_FOUND — never FORBIDDEN — so the
 * existence of other tenants' records is not revealed.
 */
@Injectable()
export class TenantScopeService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  scopeOf(actor: Actor): TenantScope {
    switch (actor.organizationType) {
      case 'PLATFORM':
        return { kind: 'ALL' };
      // Resellers and API partners both see themselves plus the merchants directly under them.
      case 'RESELLER':
      case 'API_PARTNER':
        return { kind: 'RESELLER', resellerOrgId: actor.organizationId };
      // Agents see only their own organization, like merchants.
      case 'MERCHANT':
      case 'AGENT':
        return { kind: 'ORG', orgId: actor.organizationId };
    }
  }

  /** `where` fragment for the organizations table. */
  organizationWhere(actor: Actor): Prisma.OrganizationWhereInput {
    const scope = this.scopeOf(actor);
    switch (scope.kind) {
      case 'ALL':
        return {};
      case 'RESELLER':
        return { OR: [{ id: scope.resellerOrgId }, { parentId: scope.resellerOrgId }] };
      case 'ORG':
        return { id: scope.orgId };
    }
  }

  /** Organization ids visible to the actor, or null for "all" (platform). */
  async accessibleOrganizationIds(actor: Actor): Promise<string[] | null> {
    const scope = this.scopeOf(actor);
    if (scope.kind === 'ALL') return null;
    if (scope.kind === 'ORG') return [scope.orgId];
    const children = await this.prisma.organization.findMany({
      where: { parentId: scope.resellerOrgId },
      select: { id: true },
    });
    return [scope.resellerOrgId, ...children.map((c) => c.id)];
  }

  /** Load an organization if (and only if) it is in scope; NOT_FOUND otherwise. */
  async requireOrganization(actor: Actor, organizationId: string) {
    const org = await this.prisma.organization.findFirst({
      where: { AND: [{ id: organizationId }, this.organizationWhere(actor)] },
      select: { id: true, type: true, status: true, parentId: true, name: true },
    });
    if (!org) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found');
    return org;
  }
}
