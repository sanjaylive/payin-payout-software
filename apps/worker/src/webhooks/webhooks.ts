import type { FieldEncryptor } from '@pay2all/auth';
import { newId } from '@pay2all/auth';
import type { PrismaClient, TransactionClient, WebhookDelivery } from '@pay2all/database';
import { type EventEnvelope, signWebhook, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, WEBHOOK_SIGNATURE_HEADER } from '@pay2all/events';
import type { Logger } from '@pay2all/logger';
import { queueNotification } from '../notifications/notifications';
import { safePost, UnsafeDestinationError } from './safe-http';

export const AUTO_DISABLE_AFTER = 100;
const endpointAad = (id: string) => `webhook-endpoint:${id}`;

/**
 * Dispatcher (consumer of payment/refund/payout events): fan a recorded merchant event out to the
 * merchant's active, subscribed endpoints. Runs inside the consumer's processed_events transaction,
 * and deliveries are unique per (event, endpoint), so replays never duplicate.
 */
export async function dispatchMerchantEvent(tx: TransactionClient, envelope: EventEnvelope): Promise<number> {
  const eventId = envelope.payload.event_id;
  if (typeof eventId !== 'string' || !eventId.startsWith('evt_')) return 0;
  const event = await tx.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error(`Webhook event ${eventId} not found`);
  const endpoints = await tx.webhookEndpoint.findMany({ where: { merchantId: event.merchantId, status: 'ACTIVE' } });
  const subscribed = endpoints.filter((e) => e.events.length === 0 || e.events.includes(event.type));
  if (!subscribed.length) return 0;
  const res = await tx.webhookDelivery.createMany({
    data: subscribed.map((e) => ({ id: newId('webhookDelivery'), eventId: event.id, endpointId: e.id, merchantId: event.merchantId, eventType: event.type, nextAttemptAt: new Date() })),
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * Delivery sender: claims due deliveries (SKIP LOCKED + 2-minute lease), signs and POSTs them
 * through the SSRF-safe client, logs every attempt, and schedules retries (1 m → 24 h, 9 attempts).
 * An endpoint failing 100 attempts in a row is auto-disabled and the merchant's admins are emailed.
 */
export class WebhookSender {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly logger: Logger,
    private readonly opts: { allowPrivateTargets: boolean; timeoutMs?: number; concurrency?: number },
  ) {}

  async sendDue(limit = 25): Promise<number> {
    const due = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= ${new Date()}
         ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      if (rows.length) await tx.webhookDelivery.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { nextAttemptAt: new Date(Date.now() + 2 * 60_000) } });
      return rows.map((r) => r.id);
    });
    const concurrency = this.opts.concurrency ?? 10;
    for (let i = 0; i < due.length; i += concurrency) {
      await Promise.all(due.slice(i, i + concurrency).map((id) => this.deliver(id).catch((err: unknown) => this.logger.error({ err, deliveryId: id }, 'Webhook delivery crashed'))));
    }
    return due.length;
  }

  private async deliver(id: string) {
    const d = await this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { endpoint: true } });
    if (d.status !== 'PENDING') return;
    const attemptNo = d.attempts + 1;
    if (d.endpoint.status !== 'ACTIVE') {
      await this.prisma.webhookDelivery.update({ where: { id }, data: { status: 'FAILED', lastError: 'Endpoint is disabled', nextAttemptAt: null } });
      return;
    }
    const event = await this.prisma.webhookEvent.findUniqueOrThrow({ where: { id: d.eventId } });
    const body = JSON.stringify(event.payload);
    const secrets = [this.encryptor.decrypt(d.endpoint.secretEncrypted, endpointAad(d.endpoint.id))];
    // Rotation overlap: the previous secret's ciphertext was bound to the same endpoint id.
    if (d.endpoint.previousSecretEncrypted && d.endpoint.previousSecretExpiresAt && d.endpoint.previousSecretExpiresAt > new Date()) {
      secrets.push(this.encryptor.decrypt(d.endpoint.previousSecretEncrypted, endpointAad(d.endpoint.id)));
    }
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Pay2All-Webhooks/1.0',
      'pay2all-event-id': event.id,
      'pay2all-event-type': event.type,
      'pay2all-delivery-id': d.id,
      'pay2all-delivery-attempt': String(attemptNo),
      [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: signWebhook(secrets, body),
    };
    let status: number | null = null;
    let error: string | null = null;
    let snippet: string | null = null;
    const started = Date.now();
    try {
      const res = await safePost(d.endpoint.url, body, headers, { timeoutMs: this.opts.timeoutMs ?? 10_000, allowPrivate: this.opts.allowPrivateTargets });
      status = res.status;
      snippet = res.bodySnippet || null;
      if (status < 200 || status >= 300) error = `HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}`;
    } catch (err) {
      error = err instanceof UnsafeDestinationError ? `Blocked: ${err.message}` : (err instanceof Error ? err.message : String(err));
    }
    await this.record(d, attemptNo, { status, error, snippet, durationMs: Date.now() - started });
  }

  private async record(d: WebhookDelivery & { endpoint: { id: string; merchantId: string; consecutiveFailures: number; url: string } }, attemptNo: number, r: { status: number | null; error: string | null; snippet: string | null; durationMs: number }) {
    const ok = r.error === null;
    const final = !ok && attemptNo >= WEBHOOK_MAX_ATTEMPTS;
    const disable = !ok && d.endpoint.consecutiveFailures + 1 >= AUTO_DISABLE_AFTER;
    await this.prisma.$transaction(async (tx) => {
      await tx.webhookDeliveryAttempt.create({ data: { id: newId('webhookAttempt'), deliveryId: d.id, attemptNo, statusCode: r.status, durationMs: r.durationMs, error: r.error?.slice(0, 500) ?? null, responseSnippet: r.snippet?.slice(0, 1000) ?? null } });
      await tx.webhookDelivery.update({
        where: { id: d.id },
        data: {
          attempts: attemptNo,
          lastStatusCode: r.status,
          lastError: r.error?.slice(0, 500) ?? null,
          lastAttemptAt: new Date(),
          ...(ok ? { status: 'SUCCEEDED', deliveredAt: new Date(), nextAttemptAt: null } : final ? { status: 'FAILED', nextAttemptAt: null } : { nextAttemptAt: new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[attemptNo - 1]!) }),
        },
      });
      if (ok) await tx.webhookEndpoint.update({ where: { id: d.endpoint.id }, data: { consecutiveFailures: 0, lastSuccessAt: new Date() } });
      else if (!disable) await tx.webhookEndpoint.update({ where: { id: d.endpoint.id }, data: { consecutiveFailures: { increment: 1 } } });
      else {
        const res = await tx.webhookEndpoint.updateMany({ where: { id: d.endpoint.id, status: 'ACTIVE' }, data: { status: 'DISABLED', consecutiveFailures: { increment: 1 }, disabledReason: `Auto-disabled after ${AUTO_DISABLE_AFTER} consecutive failed attempts` } });
        if (res.count === 1) await this.notifyDisabled(tx, d.endpoint.merchantId, d.endpoint.url);
      }
    });
    if (!ok) this.logger.warn({ deliveryId: d.id, endpointId: d.endpoint.id, attemptNo, status: r.status, final }, 'Webhook delivery attempt failed');
  }

  private async notifyDisabled(tx: TransactionClient, merchantId: string, url: string) {
    const admins = await tx.userRole.findMany({ where: { organizationId: merchantId, role: { key: { in: ['MERCHANT_OWNER', 'MERCHANT_ADMIN', 'MERCHANT_DEVELOPER'] } }, user: { status: 'ACTIVE' } }, select: { user: { select: { id: true, email: true } } } });
    for (const { user } of admins) {
      await queueNotification(tx, this.encryptor, {
        to: user.email,
        userId: user.id,
        template: 'webhook_endpoint_disabled',
        subject: 'A Pay2All webhook endpoint was disabled',
        text: `Your webhook endpoint ${new URL(url).host} failed ${AUTO_DISABLE_AFTER} deliveries in a row and has been disabled. Fix the endpoint, enable it again under Developers → Webhooks, and replay failed deliveries from the webhook log.`,
      });
    }
  }
}
