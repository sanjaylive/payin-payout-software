import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSION_KEYS, PERMISSIONS } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { PRISMA } from '../../infra/tokens';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';

@ApiTags('Roles & permissions')
@ApiBearerAuth()
@Controller('v1')
export class RolesController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get('roles')
  @RequirePermissions('role.read')
  @ApiOperation({ summary: 'Roles grantable in scope (platform staff see every scope)' })
  async listRoles(@CurrentActor() actor: Actor) {
    const roles = await this.prisma.role.findMany({
      where: {
        AND: [
          actor.organizationType === 'PLATFORM' ? {} : { scope: actor.organizationType },
          { OR: [{ organizationId: null }, { organizationId: actor.organizationId }] },
        ],
      },
      orderBy: [{ scope: 'asc' }, { key: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        scope: true,
        isSystem: true,
        requiresMfa: true,
        permissions: { select: { permissionKey: true }, orderBy: { permissionKey: 'asc' } },
        _count: { select: { memberships: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      scope: r.scope,
      is_system: r.isSystem,
      requires_mfa: r.requiresMfa,
      permissions: r.permissions.map((p) => p.permissionKey),
      // Member counts across all tenants are platform-only information.
      ...(actor.organizationType === 'PLATFORM' ? { member_count: r._count.memberships } : {}),
    }));
  }

  @Get('permissions')
  @RequirePermissions('role.read')
  @ApiOperation({ summary: 'Permission catalog' })
  listPermissions() {
    return PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key].description, scopes: PERMISSIONS[key].scopes }));
  }
}
