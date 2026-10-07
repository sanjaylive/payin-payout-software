import { metrics } from '@pay2all/telemetry';
import type { FieldEncryptor } from '@pay2all/auth';
import { newId } from '@pay2all/auth';
import type { DbClient, MessagingService, Notification, PrismaClient } from '@pay2all/database';
import type { Logger } from '@pay2all/logger';
import { MESSAGING_SCHEMAS, type MessagingAdapter } from '@pay2all/validation';
import nodemailer, { type Transporter } from 'nodemailer';
import { ChannelError, type ChannelSender, type OutgoingMessage, sesSender, sms21Sender, smtpSender } from './channels';

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

/** Must match the API's VendorsService. */
export const messagingSecretAad = (id: string) => `messaging:${id}`;

/**
 * Notification sender (email, SMS, WhatsApp). Claims due notifications (SKIP LOCKED + lease),
 * decrypts in memory, sends through the vendor routed for the channel, then wipes the encrypted
 * content — one-time links don't outlive delivery. Message bodies are never logged.
 *
 * Routing (docs/VENDORS.md §2): ACTIVE messaging services of ACTIVE vendors for the channel, in
 * priority order; a failure falls through to the next one. A test send targets one service only.
 * With no email service configured, email falls back to SMTP_URL (or a discarding JSON transport
 * in dev/tests) — the pre-vendor behaviour.
 */
export class NotificationSender {
  private readonly fallbackEmail: Transporter;
  /** Built senders, keyed by service id + version (a config or credential change rebuilds). */
  private readonly senders = new Map<string, ChannelSender>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly logger: Logger,
    private readonly opts: { smtpUrl: string; from: string; fetchImpl?: typeof fetch },
  ) {
    this.fallbackEmail = opts.smtpUrl ? nodemailer.createTransport(opts.smtpUrl) : nodemailer.createTransport({ jsonTransport: true });
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

  private async route(n: Notification): Promise<MessagingService[]> {
    if (n.targetServiceId) {
      const one = await this.prisma.messagingService.findUnique({ where: { id: n.targetServiceId } });
      return one ? [one] : [];
    }
    return this.prisma.messagingService.findMany({ where: { channel: n.channel, status: 'ACTIVE', vendor: { status: 'ACTIVE' } }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  }

  private sender(s: MessagingService): ChannelSender {
    const key = `${s.id}:${s.version}`;
    const cached = this.senders.get(key);
    if (cached) return cached;
    const adapter = s.adapter as MessagingAdapter;
    const config = MESSAGING_SCHEMAS[adapter].config.parse(s.config);
    const rawSecret = s.secretEncrypted ? (JSON.parse(this.encryptor.decrypt(s.secretEncrypted, messagingSecretAad(s.id))) as unknown) : null;
    const secret = rawSecret === null ? null : MESSAGING_SCHEMAS[adapter].secret.parse(rawSecret);
    let built: ChannelSender;
    if (adapter === 'ses') built = sesSender(config as never, secret as never);
    else if (adapter === 'smtp') built = smtpSender(config as never, secret as never);
    else {
      if (!secret) throw new ChannelError('sms21 API key is not configured', false);
      built = sms21Sender(s.channel === 'WHATSAPP' ? 'WHATSAPP' : 'SMS', config as never, secret as never, this.opts.fetchImpl);
    }
    for (const k of this.senders.keys()) if (k.startsWith(`${s.id}:`)) this.senders.delete(k);
    this.senders.set(key, built);
    return built;
  }

  private async sendOne(id: string) {
    const n = await this.prisma.notification.findUniqueOrThrow({ where: { id } });
    if (n.status !== 'QUEUED' || !n.contentEncrypted) return;
    let content: { to: string; subject?: string; text: string; variables?: Record<string, string> };
    try {
      content = JSON.parse(this.encryptor.decrypt(n.contentEncrypted, aad(id))) as typeof content;
    } catch {
      return this.failed(n, 'Stored message could not be decrypted', true);
    }
    const msg: OutgoingMessage = { notificationId: id, to: content.to, subject: content.subject ?? '', text: content.text, template: n.template, variables: content.variables ?? {} };
    const errors: string[] = [];
    let permanent = false;

    const services = await this.route(n);
    if (services.length === 0 && n.channel === 'EMAIL' && !n.targetServiceId) {
      try {
        const info = (await this.fallbackEmail.sendMail({ from: this.opts.from, to: msg.to, subject: msg.subject, text: msg.text })) as { messageId?: string };
        return await this.sent(n, null, info.messageId ?? null);
      } catch (err) {
        errors.push(`SMTP_URL: ${(err as Error).message}`);
      }
    } else if (services.length === 0) {
      errors.push(`No active ${n.channel} service is configured`);
    }

    for (const s of services) {
      try {
        const { messageId } = await this.sender(s).send(msg);
        await this.prisma.messagingService.update({ where: { id: s.id }, data: { lastSuccessAt: new Date() } });
        return await this.sent(n, s.id, messageId);
      } catch (err) {
        const e = err instanceof ChannelError ? err : new ChannelError((err as Error).message, false);
        errors.push(`${s.name}: ${e.message}`);
        await this.prisma.messagingService.update({ where: { id: s.id }, data: { lastFailureAt: new Date(), lastError: e.message.slice(0, 300) } });
        this.logger.warn({ notificationId: id, serviceId: s.id, channel: n.channel, permanent: e.permanent }, 'Messaging service rejected or failed a send');
        if (e.permanent) {
          permanent = true;
          break; // the message itself is bad: another vendor won't help
        }
      }
    }
    await this.failed(n, errors.join(' | '), permanent);
  }

  private async sent(n: Notification, serviceId: string | null, messageId: string | null) {
    await this.prisma.notification.update({
      where: { id: n.id },
      data: { status: 'SENT', sentAt: new Date(), contentEncrypted: null, messagingServiceId: serviceId, providerMessageId: messageId?.slice(0, 200) ?? null, attempts: { increment: 1 }, error: null },
    });
    metrics.notificationsSent.inc({ channel: n.channel, outcome: 'sent' });
  }

  private async failed(n: Notification, error: string, permanent: boolean) {
    const attempts = n.attempts + 1;
    const final = permanent || attempts >= MAX_ATTEMPTS;
    await this.prisma.notification.update({
      where: { id: n.id },
      data: { attempts, error: error.slice(0, 1000), ...(final ? { status: 'FAILED', contentEncrypted: null, nextAttemptAt: null } : { nextAttemptAt: new Date(Date.now() + RETRY_MS[attempts - 1]!) }) },
    });
    metrics.notificationsSent.inc({ channel: n.channel, outcome: final ? 'failed' : 'retry' });
    this.logger.warn({ notificationId: n.id, template: n.template, attempts, final }, 'Notification send failed');
  }
}
