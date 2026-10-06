import { Inject, Injectable } from '@nestjs/common';
import { generateToken, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { createOrganizationSchema, listOrganizationsQuerySchema, updateOrganizationStatusSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AccessProfileService } from '../access/access-profile.service';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  type: true,
  status: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

type OrgRow = Prisma.OrganizationGetPayload<{ select: typeof ORG_SELECT }>;

export function presentOrganization(o: OrgRow) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    type: o.type,
    status: o.status,
    parent_id: o.parentId,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'org';
  return `${base}-${generateToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 80);
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly profiles: AccessProfileService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor, query: z.output<typeof listOrganizationsQuerySchema>) {
    const where: Prisma.OrganizationWhereInput = {
      AND: [
        this.scope.organizationWhere(actor),
        query.type ? { type: query.type } : {},
        query.status ? { status: query.status } : {},
        query.search
          ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { id: query.search }] }
          : {},
        keysetAfter(decodeCursor(query.cursor)),
      ],
    };
    const rows = await this.prisma.organization.findMany({
      where,
      select: ORG_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, presentOrganization);
  }

  async get(actor: Actor, id: string) {
    const org = await this.prisma.organization.findFirst({
      where: { AND: [{ id }, this.scope.organizationWhere(actor)] },
      select: ORG_SELECT,
    });
    if (!org) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found');
    return presentOrganization(org);
  }

  /** Platform-only (organization.manage is PLATFORM-scoped). Merchants may hang off a reseller. */
  async create(actor: Actor, input: z.output<typeof createOrganizationSchema>) {
    if (input.type === 'MERCHANT') {
      // Merchants have an onboarding aggregate; creating a bare organization would leave it incomplete.
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Create merchants with POST /v1/merchants');
    }
    const parentId = actor.organizationId;
    if (input.parent_id) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Only merchants can be created under a reseller');
    }
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { id: newId('organization'), name: input.name, type: input.type, parentId, slug: slugify(input.name) },
        select: ORG_SELECT,
      });
      await this.audit.record(
        { action: 'organization.created', resourceType: 'organization', resourceId: org.id, organizationId: org.id, newValue: presentOrganization(org) },
        tx,
      );
      return presentOrganization(org);
    });
  }

  async updateStatus(actor: Actor, id: string, input: z.output<typeof updateOrganizationStatusSchema>) {
    const org = await this.scope.requireOrganization(actor, id);
    if (org.type === 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN, 'The platform organization cannot be changed');
    if (org.status === input.status) return this.get(actor, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.organization.update({ where: { id }, data: { status: input.status }, select: ORG_SELECT });
      await this.audit.record(
        {
          action: input.status === 'SUSPENDED' ? 'organization.suspended' : `organization.status_changed`,
          resourceType: 'organization',
          resourceId: id,
          organizationId: id,
          oldValue: { status: org.status },
          newValue: { status: input.status },
          metadata: { reason: input.reason },
        },
        tx,
      );
      return row;
    });
    await this.profiles.invalidateOrganization(id);
    return presentOrganization(updated);
  }
}
