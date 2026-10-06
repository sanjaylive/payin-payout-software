import type { FieldEncryptor } from '@pay2all/auth';
import { newId } from '@pay2all/auth';
import type { DbClient, PrismaClient } from '@pay2all/database';
import type { Logger } from '@pay2all/logger';
import nodemailer, { type Transporter } from 'nodemailer';

const aad = (id: string) => `notification:${id}`;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = RETRY_MS.length + 1;

/** Queue an email from the worker (same encrypted format as the API's NotificationsService). */
export async function queueNotification(db: DbClient, encryptor: FieldEncryptor, m: { to: string; subject: string; text: string; template: string; userId?: string | null }) {
  const id = newId('notification');
  const [user = '', domain = ''] = m.to.split('@');
  await db.notification.create({
    data: { id, channel: 'EMAIL', template: m.template, recipientMasked: `${user.slice(0, 1)}***@${domain}`, userId: m.userId ?? null, contentEncrypted: encryptor.encrypt(JSON.stringify({ to: m.to, subject: m.subject, text: m.text }), aad(id)), nextAttemptAt: new Date() },
  });
  await db.outboxEvent.create({ data: { id: newId('outboxEvent'), eventType: 'notification.send', aggregateType: 'notification', aggregateId: id, payload: { notification_id: id } } });
  return id;
}

/**
 * Email sender. Claims due notifications (SKIP LOCKED + lease), decrypts in memory, sends, then
 * wipes the encrypted content — one-time links don't outlive delivery. Message bodies are never
 * logged. Without SMTP_URL (dev/tests) it uses a JSON transport that discards the message.
 */
export class NotificationSender {
  private readonly transport: Transporter;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly logger: Logger,
    private readonly opts: { smtpUrl: string; from: string },
  ) {
    this.transport = opts.smtpUrl ? nodemailer.createTransport(opts.smtpUrl) : nodemailer.createTransport({ jsonTransport: true });
  }

  /** Send due notifications (or just `onlyId`, the Kafka fast path). Returns how many were attempted. */
  async sendDue(limit = 20, onlyId?: string): Promise<number> {
    const ids = await this.prisma.$transaction(async (tx) => {
      const rows = onlyId
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM notifications WHERE id = ${onlyId} AND status = 'QUEUED' AND next_attempt_at <= ${new Date()} FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM notifications WHERE status = 'QUEUED' AND next_attempt_at <= ${new Date()} ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      if (rows.length) await tx.notification.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { nextAttemptAt: new Date(Date.now() + 2 * 60_000) } });
      return rows.map((r) => r.id);
    });
    for (const id of ids) await this.sendOne(id);
    return ids.length;
  }

  private async sendOne(id: string) {
    const n = await this.prisma.notification.findUniqueOrThrow({ where: { id } });
    if (n.status !== 'QUEUED' || !n.contentEncrypted) return;
    try {
      const msg = JSON.parse(this.encryptor.decrypt(n.contentEncrypted, aad(id))) as { to: string; subject: string; text: string };
      const info = (await this.transport.sendMail({ from: this.opts.from, to: msg.to, subject: msg.subject, text: msg.text })) as { messageId?: string };
      await this.prisma.notification.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), contentEncrypted: null, providerMessageId: info.messageId?.slice(0, 200) ?? null, attempts: { increment: 1 }, error: null } });
    } catch (err) {
      const attempts = n.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await this.prisma.notification.update({
        where: { id },
        data: { attempts, error: (err instanceof Error ? err.message : String(err)).slice(0, 1000), ...(final ? { status: 'FAILED', contentEncrypted: null, nextAttemptAt: null } : { nextAttemptAt: new Date(Date.now() + RETRY_MS[attempts - 1]!) }) },
      });
      this.logger.warn({ notificationId: id, template: n.template, attempts, final }, 'Notification send failed');
    }
  }
}
