import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type CheckoutSession, isUniqueViolation, type Payment, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { createPaymentLinkSchema, listPaymentLinksQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

const NOTIFY_COOLDOWN_MS = 60_000;

function merchantOnly(actor: Actor) {
  if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Payment links are for merchant accounts');
  return actor.organizationId;
}

const ist = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Payment links (docs/PAYMENT_LINKS.md): a one-off request for money the merchant shares by email,
 * SMS, WhatsApp or QR. It is a checkout session of kind LINK — the customer pays on the hosted
 * checkout and ends on a receipt there (no website needed).
 */
@Injectable()
export class PaymentLinksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
    private readonly brand: BrandService,
  ) {}

  /** The merchant's customer-facing origin: its reseller's verified domain, or the platform's. */
  private base(merchantId: string) {
    return this.brand.webBase(merchantId);
  }

  private status(s: CheckoutSession) {
    return s.status === 'OPEN' && s.expiresAt.getTime() < Date.now() ? 'EXPIRED' : s.status;
  }

  present(s: CheckoutSession, payment: Payment | null | undefined, base: string) {
    return {
      id: s.id,
      object: 'payment_link',
      reference: s.merchantOrderId,
      amount: minorToMajorString(s.amountMinor),
      currency: 'INR',
      description: s.description,
      status: this.status(s),
      url: `${base}/checkout/${s.token}`,
      customer: { name: s.customerName, email: s.customerEmail, mobile: s.customerMobile },
      payment_id: s.paymentId,
      payment: payment ? { id: payment.id, status: payment.status, method: payment.method, utr: payment.utr } : null,
      attempts: s.attempts,
      metadata: s.metadata,
      notified_at: s.notifiedAt,
      expires_at: s.expiresAt,
      paid_at: s.paidAt,
      created_at: s.createdAt,
    };
  }

  private async assertCanCollect(merchantId: string) {
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true, payinEnabled: true } });
    if (m?.status !== 'APPROVED' || !m.payinEnabled) throw new AppError(ErrorCode.PAYIN_DISABLED, 'Your account must be approved for collections before creating payment links');
  }

  async create(actor: Actor, input: z.output<typeof createPaymentLinkSchema>, rawBody: unknown, idempotencyKey: string | undefined) {
    const merchantId = merchantOnly(actor);
    if ((input.notify.email && !input.customer?.email) || (input.notify.sms && !input.customer?.mobile)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the customer’s email / mobile to send the link', [{ path: 'customer', message: 'Needed to notify' }]);
    }
    const link = await this.idempotency.run({ merchantId, key: idempotencyKey, method: 'POST', path: '/v1/payment-links', body: rawBody }, async (recordId) => {
      await this.assertCanCollect(merchantId);
      const id = newId('checkoutSession');
      const reference = input.reference ?? `PL-${id.slice(3)}`;
      try {
        const s = await this.prisma.$transaction(async (tx) => {
          const created = await tx.checkoutSession.create({
            data: {
              id,
              merchantId,
              kind: 'LINK',
              token: randomBytes(24).toString('base64url'),
              merchantOrderId: reference,
              amountMinor: input.amount,
              description: input.description,
              customerName: input.customer?.name ?? null,
              customerEmail: input.customer?.email ?? null,
              customerMobile: input.customer?.mobile ?? null,
              metadata: input.metadata,
              expiresAt: new Date(Date.now() + input.expires_in_days * 86_400_000),
              createdById: actor.userId,
            },
          });
          await this.idempotency.attachResource(tx, recordId, id);
          await this.audit.record({ action: 'payment_link.created', resourceType: 'payment_link', resourceId: id, organizationId: merchantId, newValue: { reference, amount: minorToMajorString(input.amount) } }, tx);
          return created;
        });
        return { status: 201, data: this.present(s, undefined, await this.base(merchantId)), resourceId: id };
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_order_id')) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'A payment link already exists for this reference');
        throw err;
      }
    });
    // Sending is outside the idempotent block: a replay never re-sends. A failed send leaves the link
    // usable; it can be sent again from the dashboard.
    if (input.notify.email || input.notify.sms) return this.notify(actor, link.id, input.notify).catch(() => link);
    return link;
  }

  private async own(actor: Actor, id: string) {
    const merchantId = merchantOnly(actor);
    const s = await this.prisma.checkoutSession.findFirst({ where: { id, merchantId, kind: 'LINK' } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'Payment link not found');
    return s;
  }

  async get(actor: Actor, id: string) {
    const s = await this.own(actor, id);
    const payment = s.paymentId ? await this.prisma.payment.findUnique({ where: { id: s.paymentId } }) : await this.prisma.payment.findFirst({ where: { checkoutSessionId: s.id }, orderBy: { createdAt: 'desc' } });
    return this.present(s, payment, await this.base(s.merchantId));
  }

  async list(actor: Actor, q: z.output<typeof listPaymentLinksQuerySchema>) {
    const merchantId = merchantOnly(actor);
    const now = new Date();
    const statusWhere =
      q.status === 'EXPIRED' ? { OR: [{ status: 'EXPIRED' as const }, { status: 'OPEN' as const, expiresAt: { lt: now } }] } : q.status === 'OPEN' ? { status: 'OPEN' as const, expiresAt: { gte: now } } : q.status ? { status: q.status } : {};
    const rows = await this.prisma.checkoutSession.findMany({
      where: { AND: [{ merchantId, kind: 'LINK' }, statusWhere, q.reference ? { merchantOrderId: { startsWith: q.reference } } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const base = await this.base(merchantId);
    return toPage(rows, q.limit, (s) => this.present(s, undefined, base));
  }

  /** Totals for the dashboard header (last 30 days). */
  async summary(actor: Actor) {
    const merchantId = merchantOnly(actor);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.prisma.checkoutSession.groupBy({ by: ['status'], where: { merchantId, kind: 'LINK', createdAt: { gte: since } }, _count: { _all: true }, _sum: { amountMinor: true } });
    const by = (st: string) => rows.find((r) => r.status === st);
    return {
      since,
      created: rows.reduce((n, r) => n + r._count._all, 0),
      paid: by('PAID')?._count._all ?? 0,
      paid_amount: minorToMajorString(by('PAID')?._sum.amountMinor ?? 0n),
      open_amount: minorToMajorString(by('OPEN')?._sum.amountMinor ?? 0n),
    };
  }

  async cancel(actor: Actor, id: string) {
    const s = await this.own(actor, id);
    const n = await this.prisma.checkoutSession.updateMany({ where: { id: s.id, status: 'OPEN', paymentId: null }, data: { status: 'CANCELLED' } });
    if (!n.count) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only open links can be cancelled');
    await this.audit.record({ action: 'payment_link.cancelled', resourceType: 'payment_link', resourceId: s.id, organizationId: s.merchantId });
    return this.get(actor, id);
  }

  /** Email and/or SMS the link to the customer on file (rate-limited per link). */
  async notify(actor: Actor, id: string, via: { email: boolean; sms: boolean }) {
    const s = await this.own(actor, id);
    if (this.status(s) !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only open links can be sent');
    if (s.notifiedAt && Date.now() - s.notifiedAt.getTime() < NOTIFY_COOLDOWN_MS) throw new AppError(ErrorCode.RATE_LIMITED, 'This link was just sent. Wait a minute before sending it again.');
    if (via.email && !s.customerEmail) throw new AppError(ErrorCode.INVALID_REQUEST, 'This link has no customer email');
    if (via.sms && !s.customerMobile) throw new AppError(ErrorCode.INVALID_REQUEST, 'This link has no customer mobile');
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: s.merchantId }, select: { organization: { select: { name: true } }, profile: { select: { displayName: true } } } });
    const name = merchant.profile?.displayName ?? merchant.organization.name;
    const amount = `₹${minorToMajorString(s.amountMinor)}`;
    const url = `${await this.base(s.merchantId)}/checkout/${s.token}`;
    await this.prisma.$transaction(async (tx) => {
      if (via.email) {
        await this.notifications.queue(tx, {
          template: 'payment_link',
          to: s.customerEmail!,
          subject: `${name} has requested ${amount}`,
          text: `Hello${s.customerName ? ` ${s.customerName}` : ''},\n\n${name} has requested a payment of ${amount} for: ${s.description ?? s.merchantOrderId}.\n\nPay securely here: ${url}\n\nReference: ${s.merchantOrderId}\nThis link expires on ${ist(s.expiresAt)} IST.\n\nIf you weren't expecting this, you can ignore this email.`,
        });
      }
      if (via.sms) {
        await this.notifications.queue(tx, {
          channel: 'SMS',
          template: 'payment_link',
          to: s.customerMobile!,
          text: `${name} requests ${amount} for ${(s.description ?? s.merchantOrderId).slice(0, 40)}. Pay: ${url}`,
          variables: { merchant: name.slice(0, 30), amount, url },
        });
      }
      await tx.checkoutSession.update({ where: { id: s.id }, data: { notifiedAt: new Date() } });
      await this.audit.record({ action: 'payment_link.sent', resourceType: 'payment_link', resourceId: s.id, organizationId: s.merchantId, metadata: { email: via.email, sms: via.sms } }, tx);
    });
    return this.get(actor, id);
  }
}
