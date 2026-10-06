import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, WebhookDelivery, WebhookDeliveryAttempt, WebhookEndpoint } from '@pay2all/database';
import { isBlockedAddress } from '@pay2all/events';
import { ErrorCode } from '@pay2all/types';
import type { createWebhookEndpointSchema, listWebhookDeliveriesQuerySchema, listWebhookEventsQuerySchema, updateWebhookEndpointSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { ApiConfig } from '../../config/api-config';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

const MAX_ENDPOINTS = 10;
export const endpointSecretAad = (endpointId: string) => `webhook-endpoint:${endpointId}`;

function presentEndpoint(e: WebhookEndpoint) {
  return {
    endpoint_id: e.id,
    merchant_id: e.merchantId,
    url: e.url,
    description: e.description,
    events: e.events,
    status: e.status,
    disabled_reason: e.disabledReason,
    secret_hint: e.secretHint,
    consecutive_failures: e.consecutiveFailures,
    last_success_at: e.lastSuccessAt,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

function presentDelivery(d: WebhookDelivery & { endpoint?: { url: string } }, attempts?: WebhookDeliveryAttempt[]) {
  return {
    delivery_id: d.id,
    event_id: d.eventId,
    event_type: d.eventType,
    endpoint_id: d.endpointId,
    endpoint_url: d.endpoint?.url,
    merchant_id: d.merchantId,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: d.nextAttemptAt,
    last_status_code: d.lastStatusCode,
    last_error: d.lastError,
    last_attempt_at: d.lastAttemptAt,
    delivered_at: d.deliveredAt,
    created_at: d.createdAt,
    ...(attempts
      ? { attempt_log: attempts.map((a) => ({ attempt_no: a.attemptNo, status_code: a.statusCode, duration_ms: a.durationMs, error: a.error, response_snippet: a.responseSnippet, created_at: a.createdAt })) }
      : {}),
  };
}

/**
 * Merchant webhook endpoints, event log and delivery log (docs/WEBHOOKS.md). Signing secrets are
 * generated server-side, shown exactly once (create / rotate) and stored encrypted — the worker
 * needs the raw secret to sign, so it can't be a hash. Delivery happens in the worker.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ApiConfig,
  ) {}

  private assertMerchant(actor: Actor) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Webhook endpoints belong to a merchant account');
  }

  private assertUrl(raw: string) {
    const u = new URL(raw);
    if (this.config.env.WEBHOOK_REQUIRE_HTTPS && u.protocol !== 'https:') throw new AppError(ErrorCode.INVALID_REQUEST, 'Webhook URLs must use https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // Early, friendly rejection; the worker re-checks every resolved address at send time (DNS can change).
    if (this.config.env.WEBHOOK_REQUIRE_HTTPS && (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isBlockedAddress(host)))) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Webhook URLs must point to a public address');
    }
  }

  private newSecret() {
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    return { secret, hint: `whsec_…${secret.slice(-4)}` };
  }

  private async requireEndpoint(actor: Actor, id: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const e = await this.prisma.webhookEndpoint.findFirst({ where: { id, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, 'Webhook endpoint not found');
    return e;
  }

  async create(actor: Actor, input: z.output<typeof createWebhookEndpointSchema>) {
    this.assertMerchant(actor);
    this.assertUrl(input.url);
    if ((await this.prisma.webhookEndpoint.count({ where: { merchantId: actor.organizationId } })) >= MAX_ENDPOINTS) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${MAX_ENDPOINTS} webhook endpoints per account`);
    }
    const id = newId('webhookEndpoint');
    const { secret, hint } = this.newSecret();
    const e = await this.prisma.webhookEndpoint.create({
      data: { id, merchantId: actor.organizationId, url: input.url, description: input.description ?? null, events: input.events, secretEncrypted: this.encryptor.encrypt(secret, endpointSecretAad(id)), secretHint: hint, createdById: actor.userId },
    });
    await this.audit.record({ action: 'webhook.endpoint.created', resourceType: 'webhook_endpoint', resourceId: id, organizationId: e.merchantId, newValue: presentEndpoint(e) });
    return { ...presentEndpoint(e), secret };
  }

  async list(actor: Actor) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const rows = await this.prisma.webhookEndpoint.findMany({ where: ids ? { merchantId: { in: ids } } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(presentEndpoint);
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateWebhookEndpointSchema>) {
    const e = await this.requireEndpoint(actor, id);
    if (actor.organizationType !== 'MERCHANT' && input.status !== 'DISABLED') throw new AppError(ErrorCode.FORBIDDEN, 'Platform staff can only disable endpoints');
    if (input.url) this.assertUrl(input.url);
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: e.id },
      data: {
        ...(input.url ? { url: input.url } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.events ? { events: input.events } : {}),
        ...(input.status ? { status: input.status, disabledReason: input.status === 'DISABLED' ? `Disabled by ${actor.organizationType === 'MERCHANT' ? 'merchant' : 'Pay2All'}` : null, ...(input.status === 'ACTIVE' ? { consecutiveFailures: 0 } : {}) } : {}),
        version: { increment: 1 },
      },
    });
    await this.audit.record({ action: 'webhook.endpoint.updated', resourceType: 'webhook_endpoint', resourceId: e.id, organizationId: e.merchantId, oldValue: presentEndpoint(e), newValue: presentEndpoint(updated) });
    return presentEndpoint(updated);
  }

  async rotateSecret(actor: Actor, id: string) {
    this.assertMerchant(actor);
    const e = await this.requireEndpoint(actor, id);
    const { secret, hint } = this.newSecret();
    const updated = await this.prisma.webhookEndpoint.update({ where: { id: e.id }, data: { secretEncrypted: this.encryptor.encrypt(secret, endpointSecretAad(e.id)), secretHint: hint, version: { increment: 1 } } });
    await this.audit.record({ action: 'webhook.endpoint.secret_rotated', resourceType: 'webhook_endpoint', resourceId: e.id, organizationId: e.merchantId, metadata: { secret_hint: hint, severity: 'MEDIUM' } });
    return { ...presentEndpoint(updated), secret };
  }

  /** Send a `webhook.test` event to one endpoint (bypasses subscriptions). */
  async sendTest(actor: Actor, id: string) {
    this.assertMerchant(actor);
    const e = await this.requireEndpoint(actor, id);
    if (e.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_REQUEST, 'Enable the endpoint first');
    const eventId = newId('webhookEvent');
    const deliveryId = newId('webhookDelivery');
    await this.prisma.$transaction(async (tx) => {
      const payload = { id: eventId, type: 'webhook.test', created_at: new Date().toISOString(), data: { message: 'Test event from Pay2All Payments', endpoint_id: e.id } };
      await tx.webhookEvent.create({ data: { id: eventId, merchantId: e.merchantId, type: 'webhook.test', payload, resourceId: e.id } });
      await tx.webhookDelivery.create({ data: { id: deliveryId, eventId, endpointId: e.id, merchantId: e.merchantId, eventType: 'webhook.test', nextAttemptAt: new Date() } });
    });
    return { event_id: eventId, delivery_id: deliveryId };
  }

  // ---- Logs ------------------------------------------------------------------------------------

  private async merchantFilter(actor: Actor, merchantId?: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (merchantId && ids && !ids.includes(merchantId)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    return merchantId ? { merchantId } : ids ? { merchantId: { in: ids } } : {};
  }

  async listEvents(actor: Actor, q: z.output<typeof listWebhookEventsQuerySchema>) {
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        AND: [
          await this.merchantFilter(actor, q.merchant_id),
          q.type ? { type: q.type } : {},
          q.resource_id ? { resourceId: q.resource_id } : {},
          cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (e) => ({ event_id: e.id, type: e.type, resource_id: e.resourceId, merchant_id: e.merchantId, api_version: e.apiVersion, payload: e.payload, created_at: e.createdAt }));
  }

  async listDeliveries(actor: Actor, q: z.output<typeof listWebhookDeliveriesQuerySchema>) {
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.WebhookDeliveryWhereInput = {
      AND: [
        await this.merchantFilter(actor, q.merchant_id),
        q.endpoint_id ? { endpointId: q.endpoint_id } : {},
        q.event_id ? { eventId: q.event_id } : {},
        q.status ? { status: q.status } : {},
        cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
      ],
    };
    const rows = await this.prisma.webhookDelivery.findMany({ where, include: { endpoint: { select: { url: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 });
    return toPage(rows, q.limit, (d) => presentDelivery(d));
  }

  async getDelivery(actor: Actor, id: string) {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id, ...(await this.merchantFilter(actor)) }, include: { endpoint: { select: { url: true } }, attemptLogs: { orderBy: { attemptNo: 'asc' } } } });
    if (!d) throw new AppError(ErrorCode.NOT_FOUND, 'Delivery not found');
    const event = await this.prisma.webhookEvent.findUnique({ where: { id: d.eventId } });
    return { ...presentDelivery(d, d.attemptLogs), payload: event?.payload ?? null };
  }

  /** Replay: queue the delivery again now (new attempts are appended to the log). */
  async retry(actor: Actor, id: string) {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id, ...(await this.merchantFilter(actor)) }, include: { endpoint: true } });
    if (!d) throw new AppError(ErrorCode.NOT_FOUND, 'Delivery not found');
    if (d.endpoint.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_REQUEST, 'The endpoint is disabled; enable it first');
    await this.prisma.webhookDelivery.update({ where: { id }, data: { status: 'PENDING', nextAttemptAt: new Date() } });
    await this.audit.record({ action: 'webhook.delivery.replayed', resourceType: 'webhook_delivery', resourceId: id, organizationId: d.merchantId });
    return this.getDelivery(actor, id);
  }

  // ---- Platform: pipeline health & dead letters ------------------------------------------------

  async pipelineHealth() {
    const [backlog, oldest, dlq, pending, failed24h, disabled] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.prisma.outboxEvent.findFirst({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
      this.prisma.deadLetterEvent.count({ where: { requeuedAt: null } }),
      this.prisma.webhookDelivery.count({ where: { status: 'PENDING' } }),
      this.prisma.webhookDelivery.count({ where: { status: 'FAILED', lastAttemptAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      this.prisma.webhookEndpoint.count({ where: { status: 'DISABLED', disabledReason: { startsWith: 'Auto-disabled' } } }),
    ]);
    const notificationsQueued = await this.prisma.notification.count({ where: { status: 'QUEUED' } });
    return {
      outbox_backlog: backlog,
      outbox_oldest_age_seconds: oldest ? Math.round((Date.now() - oldest.occurredAt.getTime()) / 1000) : 0,
      dead_letters_open: dlq,
      webhook_deliveries_pending: pending,
      webhook_deliveries_failed_24h: failed24h,
      webhook_endpoints_auto_disabled: disabled,
      notifications_queued: notificationsQueued,
    };
  }

  async listDeadLetters(open: boolean) {
    const rows = await this.prisma.deadLetterEvent.findMany({ where: open ? { requeuedAt: null } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => ({ id: r.id, consumer_group: r.consumerGroup, topic: r.topic, partition: r.partition, offset: r.offset, event_id: r.eventId, event_type: r.eventType, aggregate_id: r.aggregateId, error: r.error, attempts: r.attempts, created_at: r.createdAt, requeued_at: r.requeuedAt }));
  }

  /**
   * Requeue a dead letter by writing a fresh outbox row with the same type, aggregate and payload.
   * Consumers stay idempotent on business keys (e.g. one delivery per event and endpoint).
   */
  async requeueDeadLetter(actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const dl = await tx.deadLetterEvent.findUnique({ where: { id } });
      if (!dl) throw new AppError(ErrorCode.NOT_FOUND, 'Dead letter not found');
      if (dl.requeuedAt) throw new AppError(ErrorCode.CONFLICT, 'Already requeued');
      const env = dl.envelope as { event_type?: string; aggregate_type?: string; aggregate_id?: string; payload?: Prisma.InputJsonValue };
      if (!env.event_type || !env.aggregate_type || !env.aggregate_id) throw new AppError(ErrorCode.INVALID_REQUEST, 'This message is not a valid event envelope and cannot be requeued');
      await this.outbox.add(tx, { eventType: env.event_type, aggregateType: env.aggregate_type, aggregateId: env.aggregate_id, payload: (env.payload ?? {}) as Record<string, unknown> });
      await tx.deadLetterEvent.update({ where: { id }, data: { requeuedAt: new Date(), requeuedById: actor.userId } });
      await this.audit.record({ action: 'events.dead_letter.requeued', resourceType: 'dead_letter_event', resourceId: id, organizationId: null, metadata: { event_type: env.event_type, consumer_group: dl.consumerGroup } }, tx);
    });
    return { requeued: true };
  }
}
