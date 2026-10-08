import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { type DeliveryStatus, isUniqueViolation, type MessagingService, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { maskEmail } from '../auth/auth.util';
import { PRISMA } from '../../infra/tokens';
import { messagingSecretAad } from '../vendors/vendors.service';
import { isSnsUrl, parseSnsMessage, verifySnsSignature } from './sns';

const FINAL: DeliveryStatus[] = ['DELIVERED', 'FAILED', 'EXPIRED', 'BOUNCED', 'COMPLAINED'];
const SMS21_STATUS: Record<string, DeliveryStatus | undefined> = { sent: 'SENT', delivered: 'DELIVERED', failed: 'FAILED', rejected: 'FAILED', expired: 'EXPIRED' };
const TOLERANCE_S = 300;

export const suppressionIndex = (encryptor: FieldEncryptor, email: string) => encryptor.blindIndex(email.trim().toLowerCase(), 'email-suppression');

/**
 * Delivery receipts from messaging vendors (docs/VENDORS.md §3): sms21 status webhooks (HMAC-signed)
 * and Amazon SES events through SNS (certificate-signed). Each receipt is applied once (event id),
 * never moves a final status backwards, and a hard bounce or complaint suppresses the address.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);
  private readonly certs = new Map<string, { pem: string; at: number }>();
  /** Overridable in tests; production fetches the AWS signing certificate over HTTPS. */
  fetchText = async (url: string): Promise<string> => {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
  ) {}

  private async service(id: string, adapter: 'sms21' | 'ses'): Promise<MessagingService> {
    const s = /^msv_[0-9A-Z]{26}$/.test(id) ? await this.prisma.messagingService.findUnique({ where: { id } }) : null;
    if (!s || s.adapter !== adapter) throw new AppError(ErrorCode.NOT_FOUND);
    return s;
  }

  /** Record the event id; false when it was already applied. */
  private async firstTime(serviceId: string, externalId: string, type: string) {
    try {
      await this.prisma.messagingReceiptEvent.create({ data: { id: newId('messagingReceipt'), messagingServiceId: serviceId, externalId: externalId.slice(0, 200), type: type.slice(0, 60) } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /** Apply a status to the notification the vendor knows by `providerMessageId`. */
  private async apply(serviceId: string, providerMessageId: string, status: DeliveryStatus, at: Date, detail: string | null) {
    const n = await this.prisma.notification.findFirst({ where: { messagingServiceId: serviceId, providerMessageId }, select: { id: true, deliveryStatus: true, deliveryAt: true } });
    if (!n) return false;
    // Out of order: a final state is never replaced by a non-final one, nor by an older receipt.
    if (n.deliveryStatus && FINAL.includes(n.deliveryStatus) && !FINAL.includes(status)) return false;
    if (n.deliveryAt && at < n.deliveryAt && n.deliveryStatus && FINAL.includes(n.deliveryStatus)) return false;
    await this.prisma.notification.update({ where: { id: n.id }, data: { deliveryStatus: status, deliveryAt: at, deliveryDetail: detail?.slice(0, 300) ?? null } });
    return true;
  }

  // ---- sms21 ------------------------------------------------------------------------------------

  async sms21(serviceId: string, rawBody: Buffer | undefined, headers: Record<string, string | undefined>) {
    const s = await this.service(serviceId, 'sms21');
    const secret = s.secretEncrypted ? (JSON.parse(this.encryptor.decrypt(s.secretEncrypted, messagingSecretAad(s.id))) as { webhook_secret?: string }).webhook_secret : undefined;
    if (!secret || !rawBody) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    const header = headers['sms21-signature'] ?? '';
    const parts = header.split(',').map((p) => p.split('=', 2) as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    if (!t || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'));
    const ok = parts.filter(([k]) => k === 'v1').some(([, v]) => {
      const given = Buffer.from(v ?? '');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!ok) {
      this.logger.warn({ serviceId }, 'Rejected an sms21 receipt with a bad signature');
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    }
    const e = JSON.parse(rawBody.toString('utf8')) as { id?: string; event?: string; timestamp?: string; messageId?: string; status?: string; failure?: { code?: string } | null };
    if (!e.id || !e.messageId || !e.status) return { received: true, applied: false };
    if (!(await this.firstTime(s.id, e.id, e.event ?? 'message.status'))) return { received: true, duplicate: true };
    const status = SMS21_STATUS[e.status];
    const applied = status ? await this.apply(s.id, e.messageId, status, e.timestamp ? new Date(e.timestamp) : new Date(), e.failure?.code ?? null) : false;
    return { received: true, applied };
  }

  // ---- Amazon SES via SNS ----------------------------------------------------------------------

  private async cert(url: string) {
    const hit = this.certs.get(url);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.pem;
    const pem = await this.fetchText(url);
    if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('Not a certificate');
    this.certs.set(url, { pem, at: Date.now() });
    return pem;
  }

  async ses(serviceId: string, rawBody: Buffer | undefined) {
    const s = await this.service(serviceId, 'ses');
    const topic = (s.config as { sns_topic_arn?: string } | null)?.sns_topic_arn;
    const m = rawBody ? parseSnsMessage(rawBody.toString('utf8')) : null;
    if (!m || !topic || m.TopicArn !== topic || !isSnsUrl(m.SigningCertURL, /\.pem$/)) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    let pem: string;
    try {
      pem = await this.cert(m.SigningCertURL);
    } catch {
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    }
    if (!verifySnsSignature(m, pem)) {
      this.logger.warn({ serviceId }, 'Rejected an SNS message with a bad signature');
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    }
    if (m.Type === 'SubscriptionConfirmation') {
      // Only an SNS-owned link, for the topic configured on this service.
      if (!isSnsUrl(m.SubscribeURL)) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
      await this.fetchText(m.SubscribeURL!);
      this.logger.log({ serviceId, topic }, 'Confirmed the SES notifications subscription');
      return { received: true, confirmed: true };
    }
    if (m.Type !== 'Notification') return { received: true };
    if (!(await this.firstTime(s.id, m.MessageId, 'sns'))) return { received: true, duplicate: true };

    const ev = JSON.parse(m.Message) as {
      eventType?: string;
      notificationType?: string;
      mail?: { messageId?: string; timestamp?: string };
      bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[]; timestamp?: string };
      complaint?: { complainedRecipients?: { emailAddress?: string }[]; timestamp?: string; complaintFeedbackType?: string };
      delivery?: { timestamp?: string };
    };
    const type = ev.eventType ?? ev.notificationType;
    const messageId = ev.mail?.messageId;
    if (!type || !messageId) return { received: true };
    if (type === 'Delivery') return { received: true, applied: await this.apply(s.id, messageId, 'DELIVERED', new Date(ev.delivery?.timestamp ?? m.Timestamp), null) };
    if (type === 'Bounce') {
      const permanent = ev.bounce?.bounceType === 'Permanent';
      const recipients = ev.bounce?.bouncedRecipients ?? [];
      if (permanent) for (const r of recipients) if (r.emailAddress) await this.suppress(r.emailAddress, 'BOUNCE', r.diagnosticCode ?? null);
      const detail = recipients[0]?.diagnosticCode ?? `${ev.bounce?.bounceType ?? ''} bounce`;
      return { received: true, applied: await this.apply(s.id, messageId, permanent ? 'BOUNCED' : 'SENT', new Date(ev.bounce?.timestamp ?? m.Timestamp), detail) };
    }
    if (type === 'Complaint') {
      for (const r of ev.complaint?.complainedRecipients ?? []) if (r.emailAddress) await this.suppress(r.emailAddress, 'COMPLAINT', ev.complaint?.complaintFeedbackType ?? null);
      return { received: true, applied: await this.apply(s.id, messageId, 'COMPLAINED', new Date(ev.complaint?.timestamp ?? m.Timestamp), ev.complaint?.complaintFeedbackType ?? null) };
    }
    return { received: true };
  }

  async suppress(email: string, reason: 'BOUNCE' | 'COMPLAINT' | 'MANUAL', detail: string | null) {
    try {
      await this.prisma.emailSuppression.create({ data: { id: newId('emailSuppression'), emailIndex: suppressionIndex(this.encryptor, email), masked: maskEmail(email.trim().toLowerCase()), reason, detail: detail?.slice(0, 300) ?? null } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  // ---- Admin ------------------------------------------------------------------------------------

  async suppressions() {
    const rows = await this.prisma.emailSuppression.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => ({ id: r.id, email: r.masked, reason: r.reason, detail: r.detail, created_at: r.createdAt }));
  }

  async unsuppress(id: string) {
    const n = await this.prisma.emailSuppression.deleteMany({ where: { id } });
    if (!n.count) throw new AppError(ErrorCode.NOT_FOUND, 'Not on the list');
    return { removed: true };
  }

  /** Delivery summary per service over the last 7 days. */
  async stats(serviceId: string) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await this.prisma.notification.groupBy({ by: ['deliveryStatus'], where: { messagingServiceId: serviceId, sentAt: { gte: since } }, _count: { _all: true } });
    const by = Object.fromEntries(rows.map((r) => [r.deliveryStatus ?? 'NO_RECEIPT', r._count._all]));
    return { since, sent: rows.reduce((n, r) => n + r._count._all, 0), ...by };
  }
}
