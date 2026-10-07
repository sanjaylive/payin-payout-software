import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import type { Actor } from '../auth/actor';
import { presentInbox } from './inbox.presenter';

/** The signed-in user's bell (docs/NOTIFICATIONS.md). Strictly per user: nobody reads another's. */
@Injectable()
export class InboxService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private owner(actor: Actor) {
    if (actor.kind !== 'user') throw new AppError(ErrorCode.FORBIDDEN, 'Notifications belong to dashboard users');
    return { userId: actor.userId, organizationId: actor.organizationId };
  }

  async list(actor: Actor, q: { cursor?: string; limit: number; unread?: boolean; category?: string }) {
    const where = this.owner(actor);
    const rows = await this.prisma.inboxNotification.findMany({
      where: { AND: [where, q.unread ? { readAt: null } : {}, q.category ? { category: q.category as never } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentInbox);
  }

  async unreadCount(actor: Actor) {
    return { unread: await this.prisma.inboxNotification.count({ where: { ...this.owner(actor), readAt: null } }) };
  }

  async markRead(actor: Actor, id: string, read: boolean) {
    const res = await this.prisma.inboxNotification.updateMany({ where: { id, ...this.owner(actor) }, data: { readAt: read ? new Date() : null } });
    if (res.count !== 1) throw new AppError(ErrorCode.NOT_FOUND, 'Notification not found');
    return this.unreadCount(actor);
  }

  async markAllRead(actor: Actor) {
    const res = await this.prisma.inboxNotification.updateMany({ where: { ...this.owner(actor), readAt: null }, data: { readAt: new Date() } });
    return { marked: res.count, unread: 0 };
  }

  /** Load one notification for the push stream (owner-checked). */
  async forPush(userId: string, organizationId: string, id: string) {
    const n = await this.prisma.inboxNotification.findFirst({ where: { id, userId, organizationId } });
    return n ? presentInbox(n) : null;
  }
}
