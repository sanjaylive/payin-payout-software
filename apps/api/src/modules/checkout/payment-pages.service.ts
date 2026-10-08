import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type PaymentPage, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import { emailSchema, mobileSchema, type pageFieldSchema, type savePaymentPageSchema, type startPagePaymentSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

type PageField = z.output<typeof pageFieldSchema>;
const SESSION_MINUTES = 30;
const MAX_PAGES = 100;

function merchantOnly(actor: Actor) {
  if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Payment pages are for merchant accounts');
  return actor.organizationId;
}

/**
 * Payment pages (docs/PAYMENT_LINKS.md §3): a reusable public page (/p/<slug>) for fees, donations,
 * events or products. Each payer starts a checkout session of kind PAGE on the hosted checkout; their
 * extra field answers travel in the session metadata (`f_<key>`).
 */
@Injectable()
export class PaymentPagesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly brand: BrandService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}


  private present(p: PaymentPage, base: string, stats?: { count: number; amountMinor: bigint; last?: Date | null }) {
    return {
      id: p.id,
      object: 'payment_page',
      slug: p.slug,
      url: `${base}/p/${p.slug}`,
      title: p.title,
      description: p.description,
      amount:
        p.amountType === 'FIXED'
          ? { amount_type: 'FIXED' as const, amount: minorToMajorString(p.amountMinor!) }
          : { amount_type: 'CUSTOMER' as const, min_amount: minorToMajorString(p.minAmountMinor!), max_amount: minorToMajorString(p.maxAmountMinor!) },
      fields: p.fields as PageField[],
      success_message: p.successMessage,
      status: p.status,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      ...(stats ? { stats: { payments: stats.count, collected: minorToMajorString(stats.amountMinor), last_payment_at: stats.last ?? null } } : {}),
    };
  }

  private columns(input: z.output<typeof savePaymentPageSchema>) {
    const a = input.amount;
    return {
      title: input.title,
      description: input.description ?? null,
      successMessage: input.success_message ?? null,
      fields: input.fields,
      amountType: a.amount_type,
      amountMinor: a.amount_type === 'FIXED' ? a.amount : null,
      minAmountMinor: a.amount_type === 'CUSTOMER' ? a.min_amount : null,
      maxAmountMinor: a.amount_type === 'CUSTOMER' ? a.max_amount : null,
    };
  }

  private async stats(pageIds: string[]) {
    if (!pageIds.length) return new Map<string, { count: number; amountMinor: bigint; last: Date | null }>();
    const rows = await this.prisma.checkoutSession.groupBy({ by: ['pageId'], where: { pageId: { in: pageIds }, status: 'PAID' }, _count: { _all: true }, _sum: { amountMinor: true }, _max: { paidAt: true } });
    return new Map(rows.map((r) => [r.pageId!, { count: r._count._all, amountMinor: r._sum.amountMinor ?? 0n, last: r._max.paidAt }]));
  }

  async list(actor: Actor) {
    const merchantId = merchantOnly(actor);
    const pages = await this.prisma.paymentPage.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: MAX_PAGES });
    const stats = await this.stats(pages.map((p) => p.id));
    const base = await this.brand.webBase(merchantId);
    return pages.map((p) => this.present(p, base, stats.get(p.id) ?? { count: 0, amountMinor: 0n, last: null }));
  }

  private async own(actor: Actor, id: string) {
    const merchantId = merchantOnly(actor);
    const p = await this.prisma.paymentPage.findFirst({ where: { id, merchantId } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Payment page not found');
    return p;
  }

  async get(actor: Actor, id: string) {
    const p = await this.own(actor, id);
    return this.present(p, await this.brand.webBase(p.merchantId), (await this.stats([p.id])).get(p.id) ?? { count: 0, amountMinor: 0n, last: null });
  }

  async create(actor: Actor, input: z.output<typeof savePaymentPageSchema>) {
    const merchantId = merchantOnly(actor);
    if ((await this.prisma.paymentPage.count({ where: { merchantId } })) >= MAX_PAGES) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${MAX_PAGES} payment pages`);
    try {
      const p = await this.prisma.$transaction(async (tx) => {
        const created = await tx.paymentPage.create({ data: { id: newId('paymentPage'), merchantId, slug: input.slug, createdById: actor.userId, ...this.columns(input) } });
        await this.audit.record({ action: 'payment_page.created', resourceType: 'payment_page', resourceId: created.id, organizationId: merchantId, newValue: { slug: created.slug, title: created.title } }, tx);
        return created;
      });
      return this.present(p, await this.brand.webBase(merchantId), { count: 0, amountMinor: 0n });
    } catch (err) {
      if (isUniqueViolation(err, 'slug')) throw new AppError(ErrorCode.CONFLICT, 'This page address is taken — choose another', [{ path: 'slug', message: 'Already taken' }]);
      throw err;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof savePaymentPageSchema>) {
    const before = await this.own(actor, id);
    try {
      const p = await this.prisma.$transaction(async (tx) => {
        const after = await tx.paymentPage.update({ where: { id }, data: { slug: input.slug, ...this.columns(input) } });
        await this.audit.record({ action: 'payment_page.updated', resourceType: 'payment_page', resourceId: id, organizationId: before.merchantId, oldValue: { slug: before.slug, title: before.title }, newValue: { slug: after.slug, title: after.title } }, tx);
        return after;
      });
      return this.get(actor, p.id);
    } catch (err) {
      if (isUniqueViolation(err, 'slug')) throw new AppError(ErrorCode.CONFLICT, 'This page address is taken — choose another', [{ path: 'slug', message: 'Already taken' }]);
      throw err;
    }
  }

  async setStatus(actor: Actor, id: string, status: 'ACTIVE' | 'INACTIVE') {
    const before = await this.own(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentPage.update({ where: { id }, data: { status } });
      await this.audit.record({ action: `payment_page.${status === 'ACTIVE' ? 'activated' : 'deactivated'}`, resourceType: 'payment_page', resourceId: id, organizationId: before.merchantId }, tx);
    });
    return this.get(actor, id);
  }

  /** Paid payments through a page, with the payer's field answers. */
  async payments(actor: Actor, id: string, limit = 100) {
    const p = await this.own(actor, id);
    const rows = await this.prisma.checkoutSession.findMany({ where: { pageId: p.id, status: 'PAID' }, orderBy: { paidAt: 'desc' }, take: Math.min(limit, 500) });
    const fields = p.fields as PageField[];
    return rows.map((s) => {
      const meta = s.metadata as Record<string, string>;
      return {
        checkout_session_id: s.id,
        reference: s.merchantOrderId,
        amount: minorToMajorString(s.amountMinor),
        customer: { name: s.customerName, email: s.customerEmail, mobile: s.customerMobile },
        fields: Object.fromEntries(fields.map((f) => [f.key, meta[`f_${f.key}`] ?? null])),
        payment_id: s.paymentId,
        paid_at: s.paidAt,
      };
    });
  }

  // ---- Public --------------------------------------------------------------------------------------

  private async active(slug: string) {
    const p = await this.prisma.paymentPage.findUnique({ where: { slug } });
    if (!p || p.status !== 'ACTIVE') throw new AppError(ErrorCode.NOT_FOUND, 'This payment page is not available');
    const m = await this.prisma.merchant.findUnique({ where: { id: p.merchantId }, select: { status: true, payinEnabled: true, organization: { select: { name: true, status: true } }, profile: { select: { displayName: true } } } });
    if (m?.status !== 'APPROVED' || !m.payinEnabled || m.organization.status !== 'ACTIVE') throw new AppError(ErrorCode.NOT_FOUND, 'This payment page is not available');
    return { page: p, merchantName: m.profile?.displayName ?? m.organization.name };
  }

  /** What /p/<slug> shows: nothing beyond the page itself and the merchant's public name. */
  async publicView(slug: string) {
    const { page, merchantName } = await this.active(slug);
    const brand = await this.brand.forOrganization(page.merchantId);
    const v = this.present(page, await this.brand.webBase(page.merchantId));
    return { slug: v.slug, title: v.title, description: v.description, amount: v.amount, fields: v.fields, merchant: { name: merchantName }, platform: { name: brand.product_name }, brand: { name: brand.product_name, primary_color: brand.primary_color, logo_url: brand.assets.logo?.url ?? null } };
  }

  /** A payer starts paying: validates amount and answers, then opens a 30-minute checkout. */
  async start(slug: string, input: z.output<typeof startPagePaymentSchema>) {
    const { page } = await this.active(slug);
    let amount: bigint;
    if (page.amountType === 'FIXED') amount = page.amountMinor!;
    else {
      if (input.amount === undefined) throw new AppError(ErrorCode.INVALID_REQUEST, 'Enter an amount', [{ path: 'amount', message: 'Required' }]);
      if (input.amount < page.minAmountMinor! || input.amount > page.maxAmountMinor!) {
        throw new AppError(ErrorCode.INVALID_REQUEST, `Enter an amount between ₹${minorToMajorString(page.minAmountMinor!)} and ₹${minorToMajorString(page.maxAmountMinor!)}`, [{ path: 'amount', message: 'Out of range' }]);
      }
      amount = input.amount;
    }
    const metadata: Record<string, string> = { payment_page_id: page.id };
    const issues: { path: string; message: string }[] = [];
    for (const f of page.fields as PageField[]) {
      const value = (input.fields[f.key] ?? '').trim();
      if (!value) {
        if (f.required) issues.push({ path: `fields.${f.key}`, message: `${f.label} is required` });
        continue;
      }
      const ok = f.type === 'email' ? emailSchema.safeParse(value).success : f.type === 'phone' ? mobileSchema.safeParse(value).success : f.type === 'number' ? /^-?\d+(\.\d+)?$/.test(value) : true;
      if (!ok) issues.push({ path: `fields.${f.key}`, message: `Enter a valid ${f.label.toLowerCase()}` });
      else metadata[`f_${f.key}`] = value.slice(0, 200);
    }
    if (issues.length) throw new AppError(ErrorCode.INVALID_REQUEST, issues[0]!.message, issues);

    const id = newId('checkoutSession');
    const s = await this.prisma.checkoutSession.create({
      data: {
        id,
        merchantId: page.merchantId,
        kind: 'PAGE',
        pageId: page.id,
        token: randomBytes(24).toString('base64url'),
        merchantOrderId: `PG-${id.slice(3)}`,
        amountMinor: amount,
        description: page.title.slice(0, 200),
        customerName: input.customer.name,
        customerEmail: input.customer.email,
        customerMobile: input.customer.mobile,
        metadata,
        expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000),
      },
    });
    return { token: s.token, url: `${await this.brand.webBase(page.merchantId)}/checkout/${s.token}` };
  }
}
