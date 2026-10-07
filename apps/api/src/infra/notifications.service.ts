import { Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { DbClient } from '@pay2all/database';
import { RequestContextStore } from '../common/context/request-context';
import { OutboxService } from './outbox.service';

export interface NotificationMessage {
  /** Default EMAIL. SMS / WHATSAPP go through the vendor routed for that channel (docs/VENDORS.md). */
  channel?: 'EMAIL' | 'SMS' | 'WHATSAPP';
  /** Email address, or mobile in international format for SMS / WhatsApp. */
  to: string;
  /** Email only. */
  subject?: string;
  /** Email body / free-text SMS (test keys only for live India SMS). */
  text: string;
  /** Stable template key (e.g. password_reset); SMS / WhatsApp map it to an approved vendor template. */
  template: string;
  /** Values for SMS / WhatsApp template variables. */
  variables?: Record<string, string>;
  userId?: string | null;
  /** Send through this messaging service only (test sends). */
  targetServiceId?: string | null;
}

export const notificationAad = (id: string) => `notification:${id}`;

function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export function maskRecipient(channel: 'EMAIL' | 'SMS' | 'WHATSAPP', to: string): string {
  if (channel === 'EMAIL') return maskEmail(to);
  const digits = to.replace(/\D/g, '');
  return `${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

/**
 * Queues a notification (email, SMS or WhatsApp) for the notification worker (Phase 7). The API never talks to SMTP, so request
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
    const channel = message.channel ?? 'EMAIL';
    await db.notification.create({
      data: {
        id,
        channel,
        template: message.template,
        recipientMasked: maskRecipient(channel, message.to),
        userId: message.userId ?? null,
        targetServiceId: message.targetServiceId ?? null,
        contentEncrypted: this.encryptor.encrypt(
          JSON.stringify({ to: message.to, subject: message.subject ?? '', text: message.text, variables: message.variables ?? {} }),
          notificationAad(id),
        ),
        nextAttemptAt: new Date(),
        requestId: RequestContextStore.get()?.requestId ?? null,
      },
    });
    await this.outbox.add(db, { eventType: 'notification.send', aggregateType: 'notification', aggregateId: id, payload: { notification_id: id } });
    return id;
  }
}
