import { monotonicFactory } from 'ulid';
import type { InboxCategory, InboxSeverity, Prisma } from './generated/prisma/client';
import type { DbClient } from './index';

const ulid = monotonicFactory();
const inboxId = () => `inb_${ulid()}`;

export interface InboxInput {
  /** Whose people receive it. Use `platformOrganizationId()` for Pay2All staff. */
  organizationId: string;
  /** Members holding this permission (via any role) — and/or these specific users. */
  audience: { permission?: string; userIds?: Array<string | null | undefined>; excludeUserIds?: Array<string | null | undefined> };
  category: InboxCategory;
  severity?: InboxSeverity;
  title: string;
  body: string;
  /** In-app path only (enforced by a CHECK constraint). */
  link?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Same key + same user = one notification, whatever the retries. */
  dedupeKey?: string | null;
}

/**
 * Create bell notifications for every ACTIVE member of the organization who matches the audience
 * (docs/NOTIFICATIONS.md). Runs on the caller's transaction: the rows — and, via the insert
 * trigger's pg_notify, the real-time push — exist only if that transaction commits.
 * Returns the number of recipients.
 */
export async function notifyInbox(db: DbClient, input: InboxInput): Promise<number> {
  const explicit = (input.audience.userIds ?? []).filter((u): u is string => Boolean(u));
  const exclude = new Set((input.audience.excludeUserIds ?? []).filter((u): u is string => Boolean(u)));
  const where: Prisma.UserRoleWhereInput = {
    organizationId: input.organizationId,
    user: { status: 'ACTIVE' },
    OR: [
      ...(input.audience.permission ? [{ role: { permissions: { some: { permissionKey: input.audience.permission } } } }] : []),
      ...(explicit.length ? [{ userId: { in: explicit } }] : []),
    ],
  };
  if (!input.audience.permission && !explicit.length) return 0;
  const members = await db.userRole.findMany({ where, select: { userId: true }, distinct: ['userId'] });
  const recipients = members.map((m) => m.userId).filter((u) => !exclude.has(u));
  if (!recipients.length) return 0;
  const res = await db.inboxNotification.createMany({
    data: recipients.map((userId) => ({
      id: inboxId(),
      userId,
      organizationId: input.organizationId,
      category: input.category,
      severity: input.severity ?? 'INFO',
      title: input.title.slice(0, 140),
      body: input.body.slice(0, 500),
      link: input.link ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

let platformId: string | null = null;
/** The Pay2All platform organization (cached; there is exactly one). */
export async function platformOrganizationId(db: DbClient): Promise<string | null> {
  if (platformId) return platformId;
  const org = await db.organization.findFirst({ where: { type: 'PLATFORM' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  platformId = org?.id ?? null;
  return platformId;
}
