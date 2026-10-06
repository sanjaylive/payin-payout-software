import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma, PrismaClient } from '@pay2all/database';
import { listAuditLogsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('v1/audit-logs')
export class AuditController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
  ) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'Search the append-only audit trail (scoped to the caller’s tenants)' })
  @ApiZodQuery(listAuditLogsQuerySchema)
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: z.output<typeof listAuditLogsQuerySchema>,
  ) {
    let orgFilter: Prisma.AuditLogWhereInput = {};
    if (query.organization_id) {
      await this.scope.requireOrganization(actor, query.organization_id);
      orgFilter = { organizationId: query.organization_id };
    } else {
      const ids = await this.scope.accessibleOrganizationIds(actor);
      // Tenants never see platform-level rows (organizationId NULL, e.g. failed logins).
      if (ids) orgFilter = { organizationId: { in: ids } };
    }

    const rows = await this.prisma.auditLog.findMany({
      where: {
        AND: [
          orgFilter,
          query.actor_id ? { actorId: query.actor_id } : {},
          query.action ? { action: { startsWith: query.action } } : {},
          query.resource_type ? { resourceType: query.resource_type } : {},
          query.resource_id ? { resourceId: query.resource_id } : {},
          query.from || query.to
            ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
            : {},
          keysetAfter(decodeCursor(query.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    return toPage(rows, query.limit, (r) => ({
      id: r.id,
      actor_type: r.actorType,
      actor_id: r.actorId,
      actor_role: r.actorRole,
      organization_id: r.organizationId,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      old_value: r.oldValue,
      new_value: r.newValue,
      metadata: r.metadata,
      ip_address: r.ipAddress,
      user_agent: r.userAgent,
      request_id: r.requestId,
      created_at: r.createdAt,
    }));
  }
}
