import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { type ApiVendor, isUniqueViolation, type MessagingService, type Prisma, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import {
  type createMessagingServiceSchema,
  type createVendorSchema,
  MESSAGING_ADAPTERS,
  MESSAGING_SCHEMAS,
  type MessagingAdapter,
  type messagingSecretSchema,
  type testMessageSchema,
  toIntlDigits,
  type updateMessagingServiceSchema,
  type updateVendorSchema,
} from '@pay2all/validation';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

export const messagingSecretAad = (id: string) => `messaging:${id}`;

const VENDOR_INCLUDE = {
  providers: { select: { id: true, code: true, name: true, kind: true, adapter: true, environment: true, status: true }, orderBy: { code: 'asc' } },
  messagingServices: { orderBy: [{ channel: 'asc' }, { priority: 'asc' }] },
} satisfies Prisma.ApiVendorInclude;
type VendorRow = Prisma.ApiVendorGetPayload<{ include: typeof VENDOR_INCLUDE }>;

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

/** Secrets are summarised as key names + last 4 characters; the encrypted bundle never leaves. */
export function presentMessagingService(m: MessagingService) {
  return {
    service_id: m.id,
    vendor_id: m.vendorId,
    channel: m.channel,
    adapter: m.adapter,
    name: m.name,
    status: m.status,
    priority: m.priority,
    config: m.config,
    has_secret: m.secretEncrypted !== null,
    secret_fingerprints: m.fingerprints,
    last_success_at: m.lastSuccessAt,
    last_failure_at: m.lastFailureAt,
    last_error: m.lastError,
    version: m.version,
    updated_at: m.updatedAt,
  };
}

function presentVendor(v: VendorRow) {
  const services = [...new Set([...v.providers.flatMap((p) => (p.kind === 'BOTH' ? ['PAYIN', 'PAYOUT'] : [p.kind])), ...v.messagingServices.map((m) => m.channel)])];
  return {
    vendor_id: v.id,
    code: v.code,
    name: v.name,
    status: v.status,
    website: v.website,
    contact_email: v.contactEmail,
    notes: v.notes,
    services,
    payment_services: v.providers.map((p) => ({ provider_id: p.id, code: p.code, name: p.name, kind: p.kind, adapter: p.adapter, environment: p.environment, status: p.status })),
    messaging_services: v.messagingServices.map(presentMessagingService),
    created_at: v.createdAt,
    updated_at: v.updatedAt,
  };
}

/** Does this service need a stored secret before it can be switched on? */
function needsSecret(m: Pick<MessagingService, 'adapter' | 'config'>): boolean {
  if (m.adapter === 'smtp') return false; // unauthenticated relays (e.g. Mailpit, internal MTA) are valid
  if (m.adapter === 'ses') return !(m.config as { use_instance_role?: boolean }).use_instance_role;
  return true;
}

function issues(err: z.ZodError, prefix: string) {
  return err.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].join('.'), message: i.message }));
}

/**
 * API vendor master (docs/VENDORS.md): vendors, the payment services (providers) they offer, and
 * their messaging services. Platform staff only; every change is audited; secrets are write-only.
 */
@Injectable()
export class VendorsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(id: string): Promise<VendorRow> {
    const v = await this.prisma.apiVendor.findUnique({ where: { id }, include: VENDOR_INCLUDE });
    if (!v) throw new AppError(ErrorCode.NOT_FOUND, 'Vendor not found');
    return v;
  }

  async list(actor: Actor) {
    platformOnly(actor);
    const rows = await this.prisma.apiVendor.findMany({ include: VENDOR_INCLUDE, orderBy: { name: 'asc' } });
    return rows.map(presentVendor);
  }

  async get(actor: Actor, id: string) {
    platformOnly(actor);
    return presentVendor(await this.load(id));
  }

  async create(actor: Actor, input: z.output<typeof createVendorSchema>) {
    platformOnly(actor);
    try {
      const v = await this.prisma.apiVendor.create({
        data: { id: newId('apiVendor'), code: input.code, name: input.name, website: input.website ?? null, contactEmail: input.contact_email ?? null, notes: input.notes ?? null },
      });
      await this.audit.record({ action: 'vendor.created', resourceType: 'api_vendor', resourceId: v.id, organizationId: null, newValue: { code: v.code, name: v.name } });
      return this.get(actor, v.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'A vendor with this code already exists');
      throw err;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateVendorSchema>) {
    platformOnly(actor);
    const before: ApiVendor = await this.load(id);
    await this.prisma.apiVendor.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.website !== undefined ? { website: input.website } : {}),
        ...(input.contact_email !== undefined ? { contactEmail: input.contact_email } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: { increment: 1 },
      },
    });
    await this.audit.record({ action: 'vendor.updated', resourceType: 'api_vendor', resourceId: id, organizationId: null, oldValue: { name: before.name, status: before.status }, newValue: input });
    return this.get(actor, id);
  }

  /** Move a payment service (provider) under this vendor — e.g. one bank offering payin and payout. */
  async linkProvider(actor: Actor, vendorId: string, providerId: string) {
    platformOnly(actor);
    await this.load(vendorId);
    const p = await this.prisma.provider.findUnique({ where: { id: providerId }, select: { id: true, vendorId: true } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Payment service not found');
    await this.prisma.provider.update({ where: { id: providerId }, data: { vendorId, version: { increment: 1 } } });
    await this.audit.record({ action: 'vendor.provider_linked', resourceType: 'provider', resourceId: providerId, organizationId: null, oldValue: { vendor_id: p.vendorId }, newValue: { vendor_id: vendorId } });
    return this.get(actor, vendorId);
  }

  // ---- Messaging services ----------------------------------------------------------------------------

  private async service(id: string) {
    const m = await this.prisma.messagingService.findUnique({ where: { id } });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, 'Messaging service not found');
    return m;
  }

  private parseConfig(adapter: string, config: unknown) {
    const parsed = MESSAGING_SCHEMAS[adapter as MessagingAdapter].config.safeParse(config);
    if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invalid configuration', issues(parsed.error, 'config'));
    return parsed.data as Prisma.InputJsonObject;
  }

  /** New services start DISABLED: add credentials, send a test, then switch on. */
  async createService(actor: Actor, vendorId: string, input: z.output<typeof createMessagingServiceSchema>) {
    platformOnly(actor);
    await this.load(vendorId);
    const m = await this.prisma.messagingService.create({
      data: { id: newId('messagingService'), vendorId, channel: input.channel, adapter: input.adapter, name: input.name, priority: input.priority, config: this.parseConfig(input.adapter, input.config), status: 'DISABLED', updatedById: actor.userId },
    });
    await this.audit.record({ action: 'messaging_service.created', resourceType: 'messaging_service', resourceId: m.id, organizationId: null, newValue: { vendor_id: vendorId, channel: m.channel, adapter: m.adapter, config: m.config } });
    return presentMessagingService(m);
  }

  async updateService(actor: Actor, id: string, input: z.output<typeof updateMessagingServiceSchema>) {
    platformOnly(actor);
    const before = await this.service(id);
    const config = input.config !== undefined ? this.parseConfig(before.adapter, input.config) : (before.config as Prisma.InputJsonObject);
    if (input.status === 'ACTIVE' && !before.secretEncrypted && needsSecret({ adapter: before.adapter, config: config as Prisma.JsonObject })) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the credentials before switching this service on');
    }
    const res = await this.prisma.messagingService.updateMany({
      where: { id, version: before.version },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        config,
        version: { increment: 1 },
        updatedById: actor.userId,
      },
    });
    if (res.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'The service was changed by someone else; reload and try again');
    const after = await this.service(id);
    await this.audit.record({
      action: 'messaging_service.updated',
      resourceType: 'messaging_service',
      resourceId: id,
      organizationId: null,
      oldValue: { status: before.status, priority: before.priority, config: before.config },
      newValue: { status: after.status, priority: after.priority, config: after.config },
      metadata: { reason: input.reason, severity: 'MEDIUM' },
    });
    return presentMessagingService(after);
  }

  /** Write-only credentials, validated per integration, encrypted with AAD bound to this service. */
  async setSecret(actor: Actor, id: string, input: z.output<typeof messagingSecretSchema>) {
    platformOnly(actor);
    const m = await this.service(id);
    const parsed = MESSAGING_SCHEMAS[m.adapter as MessagingAdapter].secret.safeParse(input.secret);
    if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invalid credentials', issues(parsed.error, 'secret'));
    const values = parsed.data as Record<string, string>;
    const fingerprints = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, `…${String(v).slice(-4)}`]));
    await this.prisma.$transaction(async (tx) => {
      await tx.messagingService.update({ where: { id }, data: { secretEncrypted: this.encryptor.encrypt(JSON.stringify(values), messagingSecretAad(id)), fingerprints, version: { increment: 1 }, updatedById: actor.userId } });
      await this.audit.record({ action: 'messaging_service.credentials.rotated', resourceType: 'messaging_service', resourceId: id, organizationId: null, newValue: { keys: Object.keys(values) }, metadata: { severity: 'HIGH' } }, tx);
    });
    return presentMessagingService(await this.service(id));
  }

  /** Queue a real message through exactly this service (works while it is still disabled). */
  async sendTest(actor: Actor, id: string, input: z.output<typeof testMessageSchema>) {
    platformOnly(actor);
    const m = await this.service(id);
    if (needsSecret(m) && !m.secretEncrypted) throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the credentials first');
    let to = input.to;
    if (m.channel === 'EMAIL') {
      if (!z.email().safeParse(to).success) throw new AppError(ErrorCode.INVALID_REQUEST, 'Enter an email address');
    } else {
      const digits = toIntlDigits(to);
      if (!digits) throw new AppError(ErrorCode.INVALID_REQUEST, 'Enter a mobile number in international format, e.g. +919876543210');
      to = digits;
    }
    const vendor = await this.prisma.apiVendor.findUniqueOrThrow({ where: { id: m.vendorId }, select: { name: true } });
    const text = `{{short}} test message via ${vendor.name} (${m.name}). If you received this, the integration works.`;
    const notificationId = await this.notifications.queue(this.prisma, {
      channel: m.channel,
      to,
      subject: '{{short}} test message',
      text,
      template: 'test',
      variables: { message: text, vendor: vendor.name },
      targetServiceId: id,
    });
    await this.audit.record({ action: 'messaging_service.test_sent', resourceType: 'messaging_service', resourceId: id, organizationId: null, metadata: { notification_id: notificationId, channel: m.channel } });
    return { notification_id: notificationId, status: 'QUEUED' };
  }

  /** Channel routing as the worker sees it: active services in fallback order. */
  async routing(actor: Actor) {
    platformOnly(actor);
    const rows = await this.prisma.messagingService.findMany({ where: { status: 'ACTIVE' }, include: { vendor: { select: { name: true, status: true } } }, orderBy: [{ channel: 'asc' }, { priority: 'asc' }] });
    return (Object.keys(MESSAGING_ADAPTERS) as Array<keyof typeof MESSAGING_ADAPTERS>).map((channel) => ({
      channel,
      services: rows.filter((r) => r.channel === channel && r.vendor.status === 'ACTIVE').map((r) => ({ service_id: r.id, name: r.name, vendor: r.vendor.name, adapter: r.adapter, priority: r.priority })),
    }));
  }

  async recentNotifications(actor: Actor, serviceId: string) {
    platformOnly(actor);
    const rows = await this.prisma.notification.findMany({
      where: { OR: [{ messagingServiceId: serviceId }, { targetServiceId: serviceId }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, channel: true, template: true, recipientMasked: true, status: true, attempts: true, providerMessageId: true, error: true, createdAt: true, sentAt: true },
    });
    return rows.map((n) => ({ notification_id: n.id, channel: n.channel, template: n.template, recipient: n.recipientMasked, status: n.status, attempts: n.attempts, provider_message_id: n.providerMessageId, error: n.error, created_at: n.createdAt, sent_at: n.sentAt }));
  }
}
