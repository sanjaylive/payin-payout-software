import { Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { DbClient } from '@pay2all/database';
import { RequestContextStore } from '../common/context/request-context';
import { OutboxService } from './outbox.service';

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable template key for analytics and the notification log (e.g. password_reset). */
  template: string;
  userId?: string | null;
}

export const notificationAad = (id: string) => `notification:${id}`;

function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/**
 * Queues an email for the notification worker (Phase 7). The API never talks to SMTP, so request
 * latency and availability don't depend on it. The rendered message can carry one-time links, so
 * it is stored encrypted (AAD = notification id) and the outbox/Kafka event carries only the id;
 * the worker decrypts, sends and wipes it.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly encryptor: FieldEncryptor,
    private readonly outbox: OutboxService,
  ) {}

  async queue(db: DbClient, message: NotificationMessage): Promise<string> {
    const id = newId('notification');
    await db.notification.create({
      data: {
        id,
        channel: 'EMAIL',
        template: message.template,
        recipientMasked: maskEmail(message.to),
        userId: message.userId ?? null,
        contentEncrypted: this.encryptor.encrypt(JSON.stringify({ to: message.to, subject: message.subject, text: message.text }), notificationAad(id)),
        nextAttemptAt: new Date(),
        requestId: RequestContextStore.get()?.requestId ?? null,
      },
    });
    await this.outbox.add(db, { eventType: 'notification.send', aggregateType: 'notification', aggregateId: id, payload: { notification_id: id } });
    return id;
  }
}
