import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type PrismaClient, type StaticQr } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { type StaticQrCredit, supportsStaticQr } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { PeriodUsageService } from '../limits/period-usage.service';
import { presentPayment } from '../payments/payment.presenter';
import { PaymentTransitionsService } from '../payments/payment-transitions.service';
import { PricingService } from '../pricing/pricing.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { RoutingService } from '../providers/routing.service';

const MAX_ACTIVE_PER_MERCHANT = 25;
const POLL_EVERY_MS = 5 * 60_000;
const POLL_LOOKBACK_MS = 24 * 3600_000;

export type CreditResult = 'RECORDED' | 'DUPLICATE' | 'UNKNOWN_QR';

/**
 * Static (printable, any-amount) UPI QR codes per merchant (docs/STATIC_QR.md). The provider issues
 * the QR; every credit it reports — by webhook or found by the reconciliation poller — becomes a
 * captured UPI_STATIC_QR payment through the normal transition code (ledger capture, merchant
 * webhook). The provider's payment id makes recording idempotent.
 */
@Injectable()
export class StaticQrService {
  private readonly logger = new Logger(StaticQrService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly routing: RoutingService,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly transitions: PaymentTransitionsService,
    private readonly usage: PeriodUsageService,
    private readonly events: MerchantEventsService,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
  ) {}

  private present(q: StaticQr, stats?: { count: number; amountMinor: bigint }, providerCode?: string) {
    return {
      id: q.id,
      object: 'static_qr',
      merchant_id: q.merchantId,
      label: q.label,
      status: q.status,
      upi_payload: q.upiPayload,
      image_url: q.imageUrl,
      provider: providerCode,
      last_credit_at: q.lastCreditAt,
      created_at: q.createdAt,
      closed_at: q.closedAt,
      ...(stats ? { today: { count: stats.count, amount: minorToMajorString(stats.amountMinor) } } : {}),
    };
  }

  private async visible(actor: Actor, id: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const q = await this.prisma.staticQr.findFirst({ where: { id, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!q) throw new AppError(ErrorCode.NOT_FOUND, 'QR code not found');
    return q;
  }

  async list(actor: Actor, merchantId?: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const where = { ...(ids ? { merchantId: { in: merchantId ? ids.filter((i) => i === merchantId) : ids } } : merchantId ? { merchantId } : {}) };
    const rows = await this.prisma.staticQr.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200, include: { provider: { select: { code: true } } } });
    const midnightIst = new Date(Math.floor((Date.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000);
    const today = rows.length
      ? await this.prisma.payment.groupBy({ by: ['staticQrId'], where: { staticQrId: { in: rows.map((r) => r.id) }, createdAt: { gte: midnightIst }, status: { notIn: ['FAILED', 'EXPIRED', 'CANCELLED'] } }, _count: { _all: true }, _sum: { amountMinor: true } })
      : [];
    const byQr = new Map(today.map((t) => [t.staticQrId, { count: t._count._all, amountMinor: t._sum.amountMinor ?? 0n }]));
    return rows.map((r) => this.present(r, byQr.get(r.id) ?? { count: 0, amountMinor: 0n }, r.provider.code));
  }

  async create(actor: Actor, label: string) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Static QR codes belong to merchant accounts');
    const merchantId = actor.organizationId;
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true, payinEnabled: true, profile: { select: { displayName: true } }, organization: { select: { name: true } } } });
    if (m?.status !== 'APPROVED' || !m.payinEnabled) throw new AppError(ErrorCode.PAYIN_DISABLED, 'Your account must be approved for collections first');
    if ((await this.prisma.staticQr.count({ where: { merchantId, status: 'ACTIVE' } })) >= MAX_ACTIVE_PER_MERCHANT) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${MAX_ACTIVE_PER_MERCHANT} active QR codes`);

    // Any provider routing would use for this merchant's static QR collections, that can issue one.
    const decision = await this.routing.decide({ service: 'PAYIN', merchantId, amountMinor: 100n, method: 'UPI_STATIC_QR' });
    const id = newId('staticQr');
    const name = m.profile?.displayName ?? m.organization.name;
    for (const c of decision.candidates) {
      const { provider, adapter } = await this.registry.payin(c.providerId);
      if (!supportsStaticQr(adapter)) continue;
      const res = await adapter.createStaticQr({ reference: id, name, description: `${name} · ${label}` });
      const q = await this.prisma.$transaction(async (tx) => {
        const created = await tx.staticQr.create({
          data: { id, merchantId, providerId: provider.id, providerQrId: res.providerQrId, label, upiPayload: res.upiPayload ?? null, imageUrl: res.imageUrl ?? null, createdById: actor.userId, lastPolledAt: new Date() },
        });
        await this.audit.record({ action: 'static_qr.created', resourceType: 'static_qr', resourceId: id, organizationId: merchantId, newValue: { label, provider: provider.code } }, tx);
        return created;
      });
      return this.present(q, { count: 0, amountMinor: 0n }, provider.code);
    }
    throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'No provider can issue a static QR for your account yet. Contact support.');
  }

  async close(actor: Actor, id: string) {
    const q = await this.visible(actor, id);
    if (actor.organizationType !== 'MERCHANT' && actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    if (q.status === 'CLOSED') return this.present(q);
    const { adapter } = await this.registry.payin(q.providerId);
    if (supportsStaticQr(adapter)) await adapter.closeStaticQr(q.providerQrId);
    // Catch any credit that arrived just before closing.
    await this.pollOne(q).catch((err: unknown) => this.logger.warn({ err, qrId: q.id }, 'Final poll before close failed'));
    const closed = await this.prisma.$transaction(async (tx) => {
      const after = await tx.staticQr.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
      await this.audit.record({ action: 'static_qr.closed', resourceType: 'static_qr', resourceId: id, organizationId: q.merchantId }, tx);
      return after;
    });
    return this.present(closed);
  }

  async credits(actor: Actor, id: string, limit = 50) {
    const q = await this.visible(actor, id);
    const rows = await this.prisma.payment.findMany({ where: { staticQrId: q.id }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
    return rows.map((p) => presentPayment(p, { list: true }));
  }

  /** Record one credit (idempotent on the provider's payment id). */
  async recordCredit(providerId: string, providerQrId: string, credit: StaticQrCredit): Promise<CreditResult> {
    const qr = await this.prisma.staticQr.findUnique({ where: { providerId_providerQrId: { providerId, providerQrId } } });
    if (!qr) return 'UNKNOWN_QR';
    const merchantOrderId = `SQR-${credit.providerPaymentId.replace(/[^A-Za-z0-9_\-/.:]/g, '-')}`.slice(0, 64);
    if (await this.prisma.payment.findUnique({ where: { merchantId_merchantOrderId: { merchantId: qr.merchantId, merchantOrderId } }, select: { id: true } })) return 'DUPLICATE';

    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: qr.merchantId }, select: { resellerId: true } });
    const quote = await this.pricing.quote({ merchantId: qr.merchantId, service: 'PAYIN', method: 'UPI_STATIC_QR', providerId: qr.providerId, amountMinor: credit.amountMinor });
    // Money already arrived, so a tiny payment is never refused: fees are capped at the amount.
    let fee = quote.merchantFeeMinor;
    let tax = quote.taxMinor;
    if (fee + tax > credit.amountMinor) {
      fee = (fee * credit.amountMinor) / (fee + tax);
      tax = credit.amountMinor - fee;
    }
    const commission = fee + tax === quote.merchantFeeMinor + quote.taxMinor ? quote.merchantCommissionMinor : 0n;
    const id = newId('payment');
    const now = new Date();
    try {
      await this.ledger.run(async (tx) => {
        const created = await tx.payment.create({
          data: {
            id,
            merchantId: qr.merchantId,
            resellerId: merchant.resellerId,
            merchantOrderId,
            staticQrId: qr.id,
            method: 'UPI_STATIC_QR',
            amountMinor: credit.amountMinor,
            feeMinor: fee,
            taxMinor: tax,
            commissionMinor: commission,
            netAmountMinor: credit.amountMinor - fee - tax + commission,
            providerId: qr.providerId,
            providerOrderId: credit.providerPaymentId,
            description: `Static QR · ${qr.label}`,
            metadata: { static_qr_id: qr.id },
            expiresAt: now,
            createdAt: now,
          },
        });
        await this.pricing.snapshot(tx, 'PAYIN', id, qr.merchantId, { ...quote, merchantFeeMinor: fee, taxMinor: tax, merchantCommissionMinor: commission });
        await this.usage.add(tx, qr.merchantId, 'PAYIN', credit.amountMinor, now);
        await this.events.emit(tx, qr.merchantId, 'payment.created', id, presentPayment(created));
        await this.transitions.applyOutcome(tx, id, { status: 'SUCCESS', amountMinor: credit.amountMinor, utr: credit.utr, rrn: credit.rrn, payerVpa: credit.payerVpa, providerTransactionId: credit.providerPaymentId, completedAt: credit.paidAt }, 'CALLBACK');
        await tx.staticQr.update({ where: { id: qr.id }, data: { lastCreditAt: now } });
      });
      return 'RECORDED';
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE';
      throw err;
    }
  }

  private async pollOne(q: StaticQr): Promise<number> {
    const { adapter } = await this.registry.payin(q.providerId);
    if (!supportsStaticQr(adapter)) return 0;
    const since = new Date(Math.min(q.lastCreditAt?.getTime() ?? q.createdAt.getTime(), (q.lastPolledAt ?? q.createdAt).getTime()) - POLL_LOOKBACK_MS);
    const credits = await adapter.listStaticQrCredits(q.providerQrId, since < q.createdAt ? q.createdAt : since);
    let recorded = 0;
    for (const c of credits) if ((await this.recordCredit(q.providerId, q.providerQrId, c)) === 'RECORDED') recorded++;
    await this.prisma.staticQr.update({ where: { id: q.id }, data: { lastPolledAt: new Date() } });
    if (recorded) this.logger.warn({ qrId: q.id, recorded }, 'Static QR poll found credits the webhook did not deliver');
    return recorded;
  }

  /** Job: reconcile active QRs every few minutes (credits whose webhook never arrived). */
  async pollActive(limit = 50): Promise<number> {
    const due = await this.prisma.staticQr.findMany({
      where: { status: 'ACTIVE', OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(Date.now() - POLL_EVERY_MS) } }] },
      orderBy: { lastPolledAt: 'asc' },
      take: limit,
    });
    let total = 0;
    for (const q of due) total += await this.pollOne(q).catch((err: unknown) => (this.logger.warn({ err, qrId: q.id }, 'Static QR poll failed'), 0));
    return total;
  }
}
