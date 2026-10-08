import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type CheckoutSession, isUniqueViolation, type MerchantWebsite, type Payment, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import type { CheckoutAction } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { addWebsiteSchema, checkoutPaySchema, createCheckoutSessionSchema, listCheckoutSessionsQuerySchema, reviewWebsiteSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { GatewaysService } from '../gateways/gateways.service';
import { PayinJobsService } from '../payments/payin-jobs.service';
import { PaymentsService } from '../payments/payments.service';
import { RoutingService } from '../providers/routing.service';

const MAX_ATTEMPTS = 10;
const OPEN_PAYMENT: Payment['status'][] = ['CREATED', 'PENDING'];

function merchantOnly(actor: Actor) {
  if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Checkout is for merchant accounts');
  return actor.organizationId;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Hosted checkout (docs/CHECKOUT.md). A merchant creates a session for an order; the customer pays on
 * our page by UPI (QR / intent) or through an enabled gateway (cards, netbanking, wallets). Each try
 * is a payment "<order>#<n>"; the first success pays the session. The customer is sent back only to
 * one of the merchant's approved websites, and outcomes always come from the provider, never from
 * what the browser brings back.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly payments: PaymentsService,
    private readonly jobs: PayinJobsService,
    private readonly routing: RoutingService,
    private readonly gateways: GatewaysService,
    private readonly brand: BrandService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  private web(path: string) {
    return `${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}${path}`;
  }

  // ---- Websites ---------------------------------------------------------------------------------

  private presentWebsite(w: MerchantWebsite, merchantName?: string) {
    return { id: w.id, merchant_id: w.merchantId, merchant_name: merchantName, url: w.url, label: w.label, status: w.status, review_note: w.reviewNote, reviewed_at: w.reviewedAt, created_at: w.createdAt };
  }

  async websites(actor: Actor) {
    const merchantId = merchantOnly(actor);
    const rows = await this.prisma.merchantWebsite.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
    return rows.map((w) => this.presentWebsite(w));
  }

  async addWebsite(actor: Actor, input: z.output<typeof addWebsiteSchema>) {
    const merchantId = merchantOnly(actor);
    if ((await this.prisma.merchantWebsite.count({ where: { merchantId } })) >= 20) throw new AppError(ErrorCode.INVALID_REQUEST, 'You can add up to 20 websites');
    if (this.config.isProduction && input.url.startsWith('http://')) throw new AppError(ErrorCode.INVALID_REQUEST, 'Websites must use https://', [{ path: 'url', message: 'Use https://' }]);
    try {
      const w = await this.prisma.$transaction(async (tx) => {
        const created = await tx.merchantWebsite.create({ data: { id: newId('website'), merchantId, url: input.url, label: input.label ?? null, createdById: actor.userId } });
        await this.audit.record({ action: 'checkout.website.added', resourceType: 'merchant_website', resourceId: created.id, organizationId: merchantId, newValue: { url: created.url } }, tx);
        return created;
      });
      return this.presentWebsite(w);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'This website is already added', [{ path: 'url', message: 'Already added' }]);
      throw err;
    }
  }

  async removeWebsite(actor: Actor, id: string) {
    const merchantId = merchantOnly(actor);
    const w = await this.prisma.merchantWebsite.findFirst({ where: { id, merchantId } });
    if (!w) throw new AppError(ErrorCode.NOT_FOUND, 'Website not found');
    if (await this.prisma.checkoutSession.count({ where: { websiteId: id } })) throw new AppError(ErrorCode.CONFLICT, 'Checkouts already use this website, so it stays on record');
    await this.prisma.$transaction(async (tx) => {
      await tx.merchantWebsite.delete({ where: { id } });
      await this.audit.record({ action: 'checkout.website.removed', resourceType: 'merchant_website', resourceId: id, organizationId: merchantId, oldValue: { url: w.url } }, tx);
    });
    return { removed: true };
  }

  /** Platform: websites waiting for review (or any status). */
  async reviewQueue(actor: Actor, status?: 'PENDING' | 'APPROVED' | 'REJECTED', merchantId?: string) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const rows = await this.prisma.merchantWebsite.findMany({ where: { ...(status ? { status } : {}), ...(merchantId ? { merchantId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const names = new Map((await this.prisma.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.merchantId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return rows.map((w) => this.presentWebsite(w, names.get(w.merchantId)));
  }

  async reviewWebsite(actor: Actor, id: string, input: z.output<typeof reviewWebsiteSchema>) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    if (input.decision === 'REJECT' && !input.note?.trim()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Say why the website is rejected', [{ path: 'note', message: 'Required' }]);
    const w = await this.prisma.$transaction(async (tx) => {
      const before = await tx.merchantWebsite.findUnique({ where: { id } });
      if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Website not found');
      const after = await tx.merchantWebsite.update({ where: { id }, data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewNote: input.note ?? null, reviewedById: actor.userId, reviewedAt: new Date() } });
      await this.audit.record({ action: `checkout.website.${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`, resourceType: 'merchant_website', resourceId: id, organizationId: before.merchantId, oldValue: { status: before.status }, newValue: { status: after.status, url: after.url }, metadata: { note: input.note } }, tx);
      return after;
    });
    return this.presentWebsite(w);
  }

  // ---- Sessions (merchant API) ------------------------------------------------------------------

  private url(s: CheckoutSession) {
    return this.web(`/checkout/${s.token}`);
  }

  private presentSession(s: CheckoutSession, payment?: Payment | null) {
    return {
      id: s.id,
      object: 'checkout_session',
      kind: s.kind,
      merchant_order_id: s.merchantOrderId,
      amount: minorToMajorString(s.amountMinor),
      currency: 'INR',
      description: s.description,
      status: this.effectiveStatus(s),
      url: this.url(s),
      return_url: s.returnUrl,
      customer: { name: s.customerName, email: s.customerEmail, mobile: s.customerMobile },
      payment_id: s.paymentId,
      payment: payment ? { id: payment.id, status: payment.status, method: payment.method, utr: payment.utr } : null,
      attempts: s.attempts,
      metadata: s.metadata,
      expires_at: s.expiresAt,
      paid_at: s.paidAt,
      created_at: s.createdAt,
    };
  }

  private effectiveStatus(s: CheckoutSession) {
    return s.status === 'OPEN' && s.expiresAt.getTime() < Date.now() ? 'EXPIRED' : s.status;
  }

  async createSession(actor: Actor, input: z.output<typeof createCheckoutSessionSchema>, rawBody: unknown, idempotencyKey: string | undefined) {
    const merchantId = merchantOnly(actor);
    return this.idempotency.run({ merchantId, key: idempotencyKey, method: 'POST', path: '/v1/checkout/sessions', body: rawBody }, async (recordId) => {
      const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true, payinEnabled: true } });
      if (m?.status !== 'APPROVED' || !m.payinEnabled) throw new AppError(ErrorCode.PAYIN_DISABLED, 'Your account must be approved for collections before using checkout');
      const origin = new URL(input.return_url).origin.toLowerCase();
      const website = await this.prisma.merchantWebsite.findFirst({ where: { merchantId, url: origin } });
      if (!website) throw new AppError(ErrorCode.INVALID_REQUEST, `${origin} is not one of your websites. Add it under Developers → Websites`, [{ path: 'return_url', message: 'Unknown website' }]);
      if (website.status !== 'APPROVED') throw new AppError(ErrorCode.INVALID_REQUEST, `${origin} is ${website.status === 'PENDING' ? 'waiting for approval' : 'not approved'}`, [{ path: 'return_url', message: 'Website not approved' }]);
      const id = newId('checkoutSession');
      try {
        const s = await this.prisma.$transaction(async (tx) => {
          const created = await tx.checkoutSession.create({
            data: {
              id,
              merchantId,
              token: randomBytes(24).toString('base64url'),
              merchantOrderId: input.merchant_order_id,
              amountMinor: input.amount,
              description: input.description ?? null,
              customerName: input.customer?.name ?? null,
              customerEmail: input.customer?.email ?? null,
              customerMobile: input.customer?.mobile ?? null,
              returnUrl: input.return_url,
              websiteId: website.id,
              metadata: input.metadata,
              expiresAt: new Date(Date.now() + input.expires_in_seconds * 1000),
              createdById: actor.userId,
            },
          });
          await this.idempotency.attachResource(tx, recordId, id);
          return created;
        });
        return { status: 201, data: this.presentSession(s), resourceId: id };
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_order_id')) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'A checkout already exists for this merchant_order_id');
        throw err;
      }
    });
  }

  async getSession(actor: Actor, id: string) {
    const merchantId = merchantOnly(actor);
    const s = await this.prisma.checkoutSession.findFirst({ where: { id, merchantId } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'Checkout session not found');
    const payment = await this.latestPayment(s);
    return this.presentSession(s, payment);
  }

  async listSessions(actor: Actor, q: z.output<typeof listCheckoutSessionsQuerySchema>) {
    const merchantId = merchantOnly(actor);
    const rows = await this.prisma.checkoutSession.findMany({
      where: { AND: [{ merchantId, kind: 'CHECKOUT' }, q.status ? (q.status === 'EXPIRED' ? { OR: [{ status: 'EXPIRED' }, { status: 'OPEN', expiresAt: { lt: new Date() } }] } : q.status === 'OPEN' ? { status: 'OPEN', expiresAt: { gte: new Date() } } : { status: q.status }) : {}, q.merchant_order_id ? { merchantOrderId: q.merchant_order_id } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (s) => this.presentSession(s));
  }

  async cancelSession(actor: Actor, id: string) {
    const merchantId = merchantOnly(actor);
    const n = await this.prisma.checkoutSession.updateMany({ where: { id, merchantId, status: 'OPEN', paymentId: null }, data: { status: 'CANCELLED' } });
    if (!n.count) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only open checkouts can be cancelled');
    return this.getSession(actor, id);
  }

  // ---- Public checkout (by token) ---------------------------------------------------------------

  private async byToken(token: string) {
    const s = await this.prisma.checkoutSession.findUnique({ where: { token } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'This checkout link is not valid');
    return s;
  }

  private latestPayment(s: CheckoutSession) {
    return s.paymentId ? this.prisma.payment.findUnique({ where: { id: s.paymentId } }) : this.prisma.payment.findFirst({ where: { checkoutSessionId: s.id }, orderBy: { createdAt: 'desc' } });
  }

  private publicPayment(p: Payment | null) {
    if (!p) return null;
    return {
      id: p.id,
      status: p.status,
      method: p.method,
      qr_payload: OPEN_PAYMENT.includes(p.status) ? p.qrPayload : null,
      upi_intent: OPEN_PAYMENT.includes(p.status) ? p.upiIntent : null,
      payment_link: OPEN_PAYMENT.includes(p.status) ? p.paymentLink : null,
      action: OPEN_PAYMENT.includes(p.status) ? ((p.checkoutAction as CheckoutAction | null) ?? null) : null,
      expires_at: p.expiresAt,
      utr: p.status === 'SUCCESS' ? p.utr : null,
      failure_reason: p.status === 'FAILED' || p.status === 'EXPIRED' ? p.failureReason : null,
    };
  }

  /** Everything the checkout page shows — nothing about the merchant beyond its public name. */
  async view(token: string) {
    const s = await this.byToken(token);
    const [merchant, brand, payment, page] = await Promise.all([
      this.prisma.merchant.findUniqueOrThrow({ where: { id: s.merchantId }, select: { organization: { select: { name: true } }, profile: { select: { displayName: true } } } }),
      this.brand.get(),
      this.latestPayment(s),
      s.pageId ? this.prisma.paymentPage.findUnique({ where: { id: s.pageId }, select: { slug: true, title: true, successMessage: true } }) : null,
    ]);
    const status = this.effectiveStatus(s);
    const methods = status === 'OPEN' ? await this.methods(s) : { upi: false, gateways: [] };
    return {
      id: s.id,
      kind: s.kind,
      // Popup checkout (checkout.js) reports the outcome only to the merchant's own approved website.
      embed_origin: s.returnUrl ? new URL(s.returnUrl).origin : null,
      merchant: { name: merchant.profile?.displayName ?? merchant.organization.name },
      platform: { name: brand.product_name },
      page: page ? { slug: page.slug, title: page.title, success_message: page.successMessage } : null,
      order: { id: s.merchantOrderId, amount: minorToMajorString(s.amountMinor), currency: 'INR', description: s.description },
      customer: { name: s.customerName, email: s.customerEmail, mobile: s.customerMobile },
      status,
      expires_at: s.expiresAt,
      methods,
      payment: this.publicPayment(payment),
      return_url: status === 'OPEN' ? null : this.returnTo(s, status),
      cancel_url: this.returnTo(s, 'CANCELLED'),
    };
  }

  private async methods(s: CheckoutSession) {
    const [upi, routed, enabled] = await Promise.all([
      this.routing.decide({ service: 'PAYIN', merchantId: s.merchantId, amountMinor: s.amountMinor, method: 'UPI_QR' }).then((d) => d.candidates.length > 0).catch(() => false),
      this.routing.decide({ service: 'PAYIN', merchantId: s.merchantId, amountMinor: s.amountMinor, method: 'PAYMENT_LINK' }).then((d) => new Set(d.candidates.map((c) => c.providerCode))).catch(() => new Set<string>()),
      this.gateways.enabledGateways(),
    ]);
    // Only gateways routing would actually use for this merchant and amount.
    const gateways = enabled.filter((g) => routed.has(g.key));
    return { upi, gateways: gateways.length ? [{ key: 'GATEWAY', name: 'Cards, netbanking & wallets', methods: [...new Set(gateways.flatMap((g) => g.methods))] }] : [] };
  }

  /**
   * The merchant's return URL with the outcome; verify server-side with GET /v1/checkout/sessions/:id.
   * Links and pages have none: the checkout page itself shows the receipt.
   */
  private returnTo(s: CheckoutSession, status: string) {
    if (!s.returnUrl) return null;
    const u = new URL(s.returnUrl);
    u.searchParams.set('checkout_session_id', s.id);
    u.searchParams.set('merchant_order_id', s.merchantOrderId);
    u.searchParams.set('status', status);
    return u.toString();
  }

  async pay(token: string, input: z.output<typeof checkoutPaySchema>) {
    const s = await this.byToken(token);
    if (this.effectiveStatus(s) !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, s.status === 'PAID' ? 'This order is already paid' : 'This checkout has expired');
    const latest = await this.latestPayment(s);
    // A UPI request still open is shown again instead of starting another.
    if (input.method === 'UPI' && latest && latest.method === 'UPI_QR' && OPEN_PAYMENT.includes(latest.status) && latest.expiresAt.getTime() > Date.now() + 30_000) return this.publicPayment(latest);
    const claimed = await this.prisma.checkoutSession.updateMany({ where: { id: s.id, status: 'OPEN', paymentId: null, attempts: { lt: MAX_ATTEMPTS } }, data: { attempts: { increment: 1 }, customerName: input.customer.name, customerEmail: input.customer.email, customerMobile: input.customer.mobile } });
    if (!claimed.count) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Too many attempts for this order — ask the merchant for a new payment link');
    const remaining = Math.floor((s.expiresAt.getTime() - Date.now()) / 1000);
    const payment = await this.payments.createCore(
      s.merchantId,
      null,
      {
        merchant_order_id: `${s.merchantOrderId}#${s.attempts + 1}`,
        amount: s.amountMinor,
        currency: 'INR',
        method: input.method === 'UPI' ? 'UPI_QR' : 'PAYMENT_LINK',
        customer: { name: input.customer.name, email: input.customer.email, mobile: input.customer.mobile },
        description: s.description ?? `Order ${s.merchantOrderId}`,
        expires_in_seconds: Math.max(120, Math.min(input.method === 'UPI' ? 600 : 1800, remaining)),
        metadata: { checkout_session_id: s.id },
      },
      { checkoutSessionId: s.id, gatewayOnly: input.method === 'GATEWAY' },
    );
    if (payment.status === 'FAILED') throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'That payment method is unavailable right now — please try another');
    return this.publicPayment(payment);
  }

  async status(token: string) {
    const s = await this.byToken(token);
    const p = await this.latestPayment(s);
    const status = this.effectiveStatus(s);
    return { status, payment: this.publicPayment(p), return_url: status === 'OPEN' ? null : this.returnTo(s, status) };
  }

  /** The customer abandons the checkout: closed if nothing is in flight. */
  async cancelByCustomer(token: string) {
    const s = await this.byToken(token);
    const open = await this.prisma.payment.count({ where: { checkoutSessionId: s.id, status: { in: OPEN_PAYMENT }, method: 'PAYMENT_LINK' } });
    if (!open) await this.prisma.checkoutSession.updateMany({ where: { id: s.id, status: 'OPEN', paymentId: null }, data: { status: 'CANCELLED' } });
    return { return_url: this.returnTo(s, 'CANCELLED') };
  }

  // ---- Gateway hand-off and return ---------------------------------------------------------------

  /** Where a gateway sends the customer back: confirm with the provider, then show the checkout page. */
  async handleReturn(paymentId: string): Promise<string> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true, checkoutSessionId: true } });
    if (!p) return this.web('/checkout/unknown');
    await this.jobs.checkNow(p.id);
    if (p.checkoutSessionId) {
      const s = await this.prisma.checkoutSession.findUnique({ where: { id: p.checkoutSessionId }, select: { token: true } });
      if (s) return this.web(`/checkout/${s.token}?returned=1`);
    }
    return this.web(`/checkout/payment/${p.id}`);
  }

  /** Minimal result for a gateway payment made outside checkout (API payment links). */
  async paymentResult(paymentId: string) {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { status: true, amountMinor: true, merchantOrderId: true } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND);
    return { status: p.status, amount: minorToMajorString(p.amountMinor), merchant_order_id: p.merchantOrderId };
  }

  /**
   * An HTML hand-off page for gateways that need a form post or their own script. Served by the API
   * with its own CSP: scripts only by nonce (+ the gateway's script host), forms only to the gateway.
   */
  async handoff(paymentId: string): Promise<{ status: number; html: string; csp: string } | { redirect: string }> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    const action = p?.checkoutAction as CheckoutAction | null | undefined;
    if (!p || !action || !OPEN_PAYMENT.includes(p.status)) return { redirect: p?.checkoutSessionId ? await this.handleReturn(paymentId) : this.web('/checkout/unknown') };
    if (action.type === 'REDIRECT') return { redirect: action.url };
    const nonce = randomBytes(16).toString('base64');
    const page = (body: string, extra: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to secure payment…</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}.c{text-align:center}.s{width:36px;height:36px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:r 1s linear infinite;margin:0 auto 16px}@keyframes r{to{transform:rotate(360deg)}}button{margin-top:12px;padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer}</style></head><body><div class="c"><div class="s"></div><p>Taking you to the secure payment page…</p>${body}</div>${extra}</body></html>`;
    if (action.type === 'FORM_POST') {
      const target = new URL(action.url);
      const inputs = Object.entries(action.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      const html = page(`<form id="f" method="post" action="${esc(action.url)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form>`, `<script nonce="${nonce}">document.getElementById('f').submit()</script>`);
      return { status: 200, html, csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action ${target.origin}; base-uri 'none'; frame-ancestors 'none'` };
    }
    const script = new URL(action.scriptUrl);
    const opts = { atomTokenId: action.atomTokenId, merchId: action.merchId, custEmail: action.custEmail, custMobile: action.custMobile, returnUrl: action.returnUrl };
    const html = page('', `<script nonce="${nonce}" src="${esc(action.scriptUrl)}"></script><script nonce="${nonce}">window.addEventListener('load',function(){new AtomPaynetz(${JSON.stringify(opts).replace(/</g, '\\u003c')},'${script.hostname.startsWith('pgtest') ? 'uat' : 'prod'}')})</script>`);
    return { status: 200, html, csp: `default-src 'none'; style-src 'unsafe-inline' ${script.origin}; img-src ${script.origin} data:; script-src 'nonce-${nonce}' ${script.origin}; connect-src ${script.origin}; frame-src https://*.atomtech.in; form-action https://*.atomtech.in ${new URL(action.returnUrl).origin}; base-uri 'none'` };
  }
}
