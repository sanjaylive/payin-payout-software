import { newId, PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES } from '@pay2all/auth';
import type { PrismaClient } from '../src/index';

/**
 * Make permissions and system roles match the code (packages/auth). Safe in every environment:
 * creates or updates them and nothing else — no organizations, users or demo data.
 * Used by the seed (development) and by `db:sync-rbac` (every deploy, after migrations).
 */
export async function syncPermissionsAndRoles(db: PrismaClient): Promise<Map<string, string>> {
  for (const key of PERMISSION_KEYS) {
    const def = PERMISSIONS[key];
    await db.permission.upsert({
      where: { key },
      create: { key, description: def.description, scopes: [...def.scopes] },
      update: { description: def.description, scopes: [...def.scopes] },
    });
  }

  const roleIds = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const existing = await db.role.findFirst({ where: { key: def.key, organizationId: null }, select: { id: true } });
    const role = existing
      ? await db.role.update({
          where: { id: existing.id },
          data: { name: def.name, description: def.description, scope: def.scope, requiresMfa: def.requiresMfa, isSystem: true },
        })
      : await db.role.create({
          data: {
            id: newId('role'),
            key: def.key,
            name: def.name,
            description: def.description,
            scope: def.scope,
            requiresMfa: def.requiresMfa,
            isSystem: true,
          },
        });
    roleIds.set(def.key, role.id);

    // Make the role's permission set exactly match the code definition.
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { notIn: [...def.permissions] } } });
    await db.rolePermission.createMany({
      data: def.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}

