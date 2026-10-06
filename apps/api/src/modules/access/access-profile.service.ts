import { Inject, Injectable } from '@nestjs/common';
import { isPermissionKey, type PermissionKey } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import type { OrganizationStatus, OrganizationType, UserStatus } from '@pay2all/types';
import type Redis from 'ioredis';
import { PRISMA, REDIS } from '../../infra/tokens';

/** Everything authorization needs about (user, organization). Cached in Redis (docs/SECURITY.md §2.2). */
export interface AccessProfile {
  userId: string;
  userStatus: UserStatus;
  organizationId: string;
  organizationType: OrganizationType;
  organizationStatus: OrganizationStatus;
  organizationParentId: string | null;
  roleKeys: string[];
  permissions: PermissionKey[];
  requiresMfa: boolean;
}

const CACHE_TTL_SECONDS = 60;
const cacheKey = (userId: string, orgId: string) => `access:${userId}:${orgId}`;
const userIndexKey = (userId: string) => `access-idx:user:${userId}`;
const orgIndexKey = (orgId: string) => `access-idx:org:${orgId}`;

@Injectable()
export class AccessProfileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Returns null when the user has no membership in the organization. */
  async get(userId: string, organizationId: string): Promise<AccessProfile | null> {
    const cached = await this.redis.get(cacheKey(userId, organizationId));
    if (cached) return JSON.parse(cached) as AccessProfile;

    const profile = await this.load(userId, organizationId);
    if (profile) {
      await this.redis
        .multi()
        .set(cacheKey(userId, organizationId), JSON.stringify(profile), 'EX', CACHE_TTL_SECONDS)
        .sadd(userIndexKey(userId), organizationId)
        .expire(userIndexKey(userId), CACHE_TTL_SECONDS * 2)
        .sadd(orgIndexKey(organizationId), userId)
        .expire(orgIndexKey(organizationId), CACHE_TTL_SECONDS * 2)
        .exec();
    }
    return profile;
  }

  async load(userId: string, organizationId: string): Promise<AccessProfile | null> {
    const [user, org, memberships] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { type: true, status: true, parentId: true },
      }),
      this.prisma.userRole.findMany({
        where: { userId, organizationId },
        select: {
          role: {
            select: { key: true, scope: true, requiresMfa: true, permissions: { select: { permissionKey: true } } },
          },
        },
      }),
    ]);
    if (!user || !org || memberships.length === 0) return null;

    const permissions = new Set<PermissionKey>();
    const roleKeys: string[] = [];
    let requiresMfa = false;
    for (const { role } of memberships) {
      // Defence in depth: ignore roles whose scope doesn't match the org type.
      if (role.scope !== org.type) continue;
      roleKeys.push(role.key);
      requiresMfa ||= role.requiresMfa;
      for (const { permissionKey } of role.permissions) {
        if (isPermissionKey(permissionKey)) permissions.add(permissionKey);
      }
    }
    if (roleKeys.length === 0) return null;

    return {
      userId,
      userStatus: user.status,
      organizationId,
      organizationType: org.type,
      organizationStatus: org.status,
      organizationParentId: org.parentId,
      roleKeys: roleKeys.sort(),
      permissions: [...permissions].sort(),
      requiresMfa,
    };
  }

  /** Invalidate after role/membership/user-status changes. Takes effect on the next request. */
  async invalidateUser(userId: string): Promise<void> {
    const orgIds = await this.redis.smembers(userIndexKey(userId));
    const keys = [...orgIds.map((o) => cacheKey(userId, o)), userIndexKey(userId)];
    await this.redis.del(...keys);
  }

  /** Invalidate every cached profile for an organization (e.g. org suspended). */
  async invalidateOrganization(organizationId: string): Promise<void> {
    const userIds = await this.redis.smembers(orgIndexKey(organizationId));
    const keys = [...userIds.map((u) => cacheKey(u, organizationId)), orgIndexKey(organizationId)];
    await this.redis.del(...keys);
  }
}
