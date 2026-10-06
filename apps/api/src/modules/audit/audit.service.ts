import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { DbClient, Prisma, PrismaClient } from '@pay2all/database';
import { redact } from '@pay2all/logger';
import { RequestContextStore } from '../../common/context/request-context';
import { PRISMA } from '../../infra/tokens';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** Tenant the action concerns. Defaults to the actor's active organization. */
  organizationId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  /** For unauthenticated events (failed login) or system jobs where there is no request actor. */
  actor?: { type: 'USER' | 'SYSTEM' | 'API_KEY'; id: string | null; role?: string | null };
}

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (redact(value));

/**
 * Append-only audit trail (docs/SECURITY.md §9). Pass the transaction client so the audit row commits
 * or rolls back together with the change it describes.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry, db: DbClient = this.prisma): Promise<void> {
    const ctx = RequestContextStore.get();
    const actor = ctx?.actor;
    await db.auditLog.create({
      data: {
        id: newId('auditLog'),
        actorType: entry.actor?.type ?? (actor ? 'USER' : 'SYSTEM'),
        actorId: entry.actor ? entry.actor.id : (actor?.userId ?? null),
        actorRole: entry.actor ? (entry.actor.role ?? null) : (actor?.roleKeys.join(',') ?? null),
        organizationId: entry.organizationId !== undefined ? entry.organizationId : (actor?.organizationId ?? null),
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        oldValue: toJson(entry.oldValue),
        newValue: toJson(entry.newValue),
        metadata: toJson(entry.metadata),
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
        requestId: ctx?.requestId ?? null,
      },
    });
  }
}
