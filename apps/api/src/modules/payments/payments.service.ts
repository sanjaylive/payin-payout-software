import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type Payment, type Prisma, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ADAPTERS, type Candidate, type CheckoutAction, classify, executeWithFailover, FailoverStoppedError, type HealthOutcome, NoProviderAvailableError, type ProviderError } from '@pay2all/providers';
import { metrics } from '@pay2all/telemetry';
import { ErrorCode } from '@pay2all/types';
import type { createPaymentSchema, listPaymentsQuerySchema, paymentStatsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { ApiConfig } from '../../config/api-config';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LimitsService } from '../limits/limits.service';
import { PeriodUsageService, periodLimitsOf } from '../limits/period-usage.service';
import { PricingService } from '../pricing/pricing.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { RoutingService } from '../providers/routing.service';
import { RiskEngineService } from '../risk/risk-engine.service';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { PaymentTransitionsService } from './payment-transitions.service';
import { presentPayment } from './payment.presenter';

const MAX_PROVIDER_ATTEMPTS = 2; // primary + one fallback (docs/PAYIN_FLOW.md §5)
const FIRST_POLL_DELAY_MS = 60_000;

export function healthOutcomeOf(err: ProviderError): HealthOutcome {
  if (err.kind === 'AMBIGUOUS') return err.code === 'TIMEOUT' ? 'TIMEOUT' : 'FAILURE';
  // A definitive rejection proves the provider is up and answering.
  return err.kind === 'REJECTED' ? 'SUCCESS' : 'FAILURE';
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly scope: TenantScopeService,
    private readonly limits: LimitsService,
    private readonly routing: RoutingService,
    private readonly pricing: PricingService,
    private readonly registry: ProviderRegistryService,
    private readonly transitions: PaymentTransitionsService,
    private readonly events: MerchantEventsService,
    private readonly audit: AuditService,
    private readonly risk: RiskEngineService,
    private readonly usage: PeriodUsageService,
    private readonly config: ApiConfig,
  ) {}

  /** Steps 4–6: merchant approved, KYC approved, payin enabled. */
  private async assertMerchantCanCollect(merchantId: string) {
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true, payinEnabled: true, resellerId: true, organization: { select: { status: true } } } });
    if (!m) throw new AppError(ErrorCode.MERCHANT_INACTIVE);
    if (m.status === 'SUSPENDED' || m.organization.status !== 'ACTIVE') throw new AppError(ErrorCode.MERCHANT_INACTIVE, 'Merchant account is suspended');
    if (m.status !== 'APPROVED') throw new AppError(ErrorCode.KYC_NOT_APPROVED, 'Merchant onboarding is not approved yet');
    if (!m.payinEnabled) throw new AppError(ErrorCode.PAYIN_DISABLED);
    return m;
  }

  /**
   * Step 7a: per-transaction limits (most specific level wins). Daily/monthly limits are enforced
   * atomically inside the create transaction from running totals (PeriodUsageService).
   */
  private async perTxnLimits(merchantId: string, amountMinor: bigint) {
    const l = await this.limits.resolveForMerchant(merchantId, 'PAYIN');
    const min = l.perTxnMinMinor.value;
    const max = l.perTxnMaxMinor.value;
    if (min !== null && amountMinor < BigInt(min)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, 'Payin minimum per-transaction limit exceeded');
    if (max !== null && amountMinor > BigInt(max)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, 'Payin maximum per-transaction limit exceeded');
    return periodLimitsOf(l);
  }

  async create(actor: Actor, input: z.output<typeof createPaymentSchema>, rawBody: unknown, idempotencyKey: string | undefined) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Payments are created by merchant accounts');
    const merchantId = actor.organizationId;
    return this.idempotency.run({ merchantId, key: idempotencyKey, method: 'POST', path: '/v1/payments', body: rawBody }, async (recordId) => {
      const payment = await this.createCore(merchantId, actor.userId, input, { recordId });
      return { status: 201, data: presentPayment(payment), resourceId: payment.id };
    });
  }

  /**
   * Everything after authentication and idempotency: shared by the API and hosted checkout.
   * `gatewayOnly` restricts routing to hosted payment gateways (checkout's cards / netbanking option).
   */
  async createCore(
    merchantId: string,
    userId: string | null,
    input: z.output<typeof createPaymentSchema>,
    opts: { recordId?: string; checkoutSessionId?: string; gatewayOnly?: boolean } = {},
  ): Promise<Payment> {
    {
      const merchant = await this.assertMerchantCanCollect(merchantId);
      const periodLimits = await this.perTxnLimits(merchantId, input.amount);

      // Step 8: risk pre-check (docs/RISK.md §4). BLOCK rejects; MANUAL_REVIEW opens a review case
      // while the customer still pays (a payin cannot wait for a human) — pair it with
      // HOLD_SETTLEMENT when the money must not leave until review.
      const id = newId('payment');
      const risk = await this.risk.assess({ service: 'PAYIN', merchantId, amountMinor: input.amount, subjectType: 'PAYMENT', subjectId: id });
      if (risk.decision === 'BLOCK') {
        await this.risk.record(this.prisma, risk);
        metrics.paymentsCreated.inc({ method: input.method, outcome: 'blocked' });
        throw new AppError(ErrorCode.RISK_BLOCKED, 'This payment was declined by risk controls. Contact support if you believe this is a mistake.');
      }

      const decision = await this.routing.decide({ service: 'PAYIN', merchantId, amountMinor: input.amount, method: input.method });
      const eligible = opts.gatewayOnly ? await this.gatewaysOnly(decision.candidates) : decision.candidates;
      const candidates = eligible.slice(0, MAX_PROVIDER_ATTEMPTS);
      if (candidates.length === 0) throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'No provider can accept this payment right now');

      const quote = await this.pricing.quote({ merchantId, service: 'PAYIN', method: input.method, providerId: candidates[0]!.providerId, amountMinor: input.amount });
      if (quote.merchantFeeMinor + quote.taxMinor >= input.amount) throw new AppError(ErrorCode.INVALID_REQUEST, 'Amount is too small to cover fees');

      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.expires_in_seconds * 1000);
      try {
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.payment.create({
            data: {
              id,
              merchantId,
              resellerId: merchant.resellerId,
              merchantOrderId: input.merchant_order_id,
              checkoutSessionId: opts.checkoutSessionId ?? null,
              method: input.method,
              amountMinor: input.amount,
              feeMinor: quote.merchantFeeMinor,
              taxMinor: quote.taxMinor,
              commissionMinor: quote.merchantCommissionMinor,
              netAmountMinor: input.amount - quote.merchantFeeMinor - quote.taxMinor + quote.merchantCommissionMinor,
              providerId: candidates[0]!.providerId,
              routeId: candidates[0]!.routeId,
              customerName: input.customer?.name ?? null,
              customerMobile: input.customer?.mobile ?? null,
              customerEmail: input.customer?.email ?? null,
              description: input.description ?? null,
              metadata: input.metadata,
              expiresAt,
              // Same instant the period usage is keyed by, so a later release hits the same rows.
              createdAt: now,
              nextPollAt: new Date(now.getTime() + FIRST_POLL_DELAY_MS),
              createdById: userId,
              requestId: RequestContextStore.get()?.requestId ?? null,
            },
          });
          await this.pricing.snapshot(tx, 'PAYIN', id, merchantId, quote);
          if (opts.recordId) await this.idempotency.attachResource(tx, opts.recordId, id);
          await this.risk.record(tx, risk);
          // Step 7b, last in the transaction so the merchant's usage row is locked only until commit.
          await this.usage.consume(tx, merchantId, 'PAYIN', input.amount, periodLimits, now);
          await this.events.emit(tx, merchantId, 'payment.created', id, presentPayment(created));
        });
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_order_id')) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'merchant_order_id has already been used');
        throw err;
      }

      // Step 12: provider call after commit, so any callback can always find the payment.
      const payment = await this.initiateWithProvider(id, candidates, input, expiresAt);
      metrics.paymentsCreated.inc({ method: input.method, outcome: payment.status === 'FAILED' ? 'provider_failed' : 'created' });
      return payment;
    }
  }

  private async gatewaysOnly(candidates: Candidate[]): Promise<Candidate[]> {
    const providers = await this.prisma.provider.findMany({ where: { id: { in: candidates.map((c) => c.providerId) } }, select: { id: true, adapter: true } });
    const gateway = new Set(providers.filter((p) => ADAPTERS[p.adapter]?.gateway).map((p) => p.id));
    return candidates.filter((c) => gateway.has(c.providerId));
  }

  /** Where hosted gateways send the customer back, and where they post notifications. */
  returnUrl(paymentId: string) {
    return `${this.config.env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/checkout/return/${paymentId}`;
  }
  private notifyUrl(providerCode: string) {
    return `${this.config.env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/webhooks/providers/${providerCode}`;
  }
  /** A payment link for any gateway action (form-post / script gateways go through our redirect page). */
  private linkFor(paymentId: string, link: string | undefined, action: CheckoutAction | undefined): string | null {
    if (link) return link;
    if (action && action.type !== 'REDIRECT') return `${this.config.env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/checkout/pay/${paymentId}`;
    return action?.url ?? null;
  }

  private async initiateWithProvider(paymentId: string, candidates: Candidate[], input: z.output<typeof createPaymentSchema>, expiresAt: Date): Promise<Payment> {
    try {
      const { result, candidate } = await executeWithFailover(
        candidates,
        async (c, attemptNo) => {
          const attemptId = newId('attempt');
          await this.prisma.paymentAttempt.create({ data: { id: attemptId, paymentId, attemptNo, providerId: c.providerId } });
          const started = Date.now();
          try {
            const { adapter } = await this.registry.payin(c.providerId);
            const res = await adapter.createPayment({ reference: paymentId, amountMinor: input.amount, currency: 'INR', method: input.method, customer: input.customer, description: input.description, expiresAt, returnUrl: this.returnUrl(paymentId), notifyUrl: this.notifyUrl(c.providerCode) });
            const latency = Date.now() - started;
            await this.prisma.paymentAttempt.update({ where: { id: attemptId }, data: { status: 'SUCCEEDED', providerOrderId: res.providerOrderId, latencyMs: latency, completedAt: new Date() } });
            await this.registry.recordOutcome(c.providerId, 'PAYIN', 'SUCCESS', latency);
            return res;
          } catch (raw) {
            const err = classify(raw, c.providerCode);
            const latency = Date.now() - started;
            await this.prisma.paymentAttempt.update({ where: { id: attemptId }, data: { status: err.kind === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'FAILED', errorKind: err.kind, errorCode: err.code, errorMessage: err.message.slice(0, 300), latencyMs: latency, completedAt: new Date() } });
            await this.registry.recordOutcome(c.providerId, 'PAYIN', healthOutcomeOf(err), latency);
            throw err;
          }
        },
        { maxAttempts: MAX_PROVIDER_ATTEMPTS },
      );
      return await this.prisma.$transaction(async (tx) => {
        const p = await this.transitions.lock(tx, paymentId);
        if (p.status !== 'CREATED') return p; // a fast callback already moved it on
        const next = await this.transitions.transition(tx, p, 'PENDING', {
          providerId: candidate.providerId,
          routeId: candidate.routeId,
          providerOrderId: result.providerOrderId,
          qrPayload: result.qrPayload ?? null,
          upiIntent: result.upiIntent ?? null,
          paymentLink: this.linkFor(p.id, result.paymentLink, result.action),
          checkoutAction: result.action ? (JSON.parse(JSON.stringify(result.action)) as Prisma.InputJsonValue) : undefined,
        });
        await this.events.emit(tx, p.merchantId, 'payment.pending', p.id, presentPayment(next));
        return next;
      });
    } catch (err) {
      if (err instanceof FailoverStoppedError) {
        // Ambiguous: the provider may have created the order. Never try a second provider; the
        // payment stays CREATED (no QR shown) and the poller/expiry sweeper resolves it.
        this.logger.warn({ paymentId, code: err.providerError.code }, 'Ambiguous provider outcome at payment creation');
        return this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      }
      if (err instanceof NoProviderAvailableError) {
        const last = err.attempts[err.attempts.length - 1];
        await this.transitions.apply(paymentId, { status: 'FAILED', failureCode: last?.errorCode ?? 'PROVIDER_UNAVAILABLE', failureReason: 'No provider could create the collect request' }, 'CREATE');
        return this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      }
      throw err;
    }
  }

  // ---- Reads -----------------------------------------------------------------------------------

  private async where(actor: Actor, extra: Prisma.PaymentWhereInput = {}): Promise<Prisma.PaymentWhereInput> {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (!ids) return extra;
    if (actor.organizationType === 'RESELLER') return { AND: [{ OR: [{ resellerId: actor.organizationId }, { merchantId: { in: ids } }] }, extra] };
    return { AND: [{ merchantId: { in: ids } }, extra] };
  }

  async get(actor: Actor, paymentId: string) {
    const p = await this.prisma.payment.findFirst({ where: await this.where(actor, { id: paymentId }), include: { refunds: { orderBy: { createdAt: 'desc' } }, attempts: { orderBy: { attemptNo: 'asc' } } } });
    if (!p) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    const internal = actor.organizationType === 'PLATFORM';
    const providerIds = [...new Set([p.providerId, ...p.attempts.map((a) => a.providerId)].filter((x): x is string => Boolean(x)))];
    const codes = new Map((await this.prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, code: true } })).map((x) => [x.id, x.code]));
    return presentPayment(p, { internal, providerCode: p.providerId ? codes.get(p.providerId) : null, refunds: p.refunds, attempts: p.attempts.map((a) => ({ ...a, providerCode: codes.get(a.providerId) })) });
  }

  async list(actor: Actor, q: z.output<typeof listPaymentsQuerySchema>) {
    if (q.merchant_id) {
      const ids = await this.scope.accessibleOrganizationIds(actor);
      if (ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    }
    const internal = actor.organizationType === 'PLATFORM';
    const cursor = decodeCursor(q.cursor);
    const asc = q.sort === 'created_asc';
    const filters: Prisma.PaymentWhereInput = {
      AND: [
        q.status ? { status: { in: q.status } } : {},
        q.method ? { method: { in: q.method } } : {},
        q.payment_id ? { id: q.payment_id } : {},
        q.merchant_order_id ? { merchantOrderId: q.merchant_order_id } : {},
        q.utr ? { utr: q.utr } : {},
        q.rrn ? { rrn: q.rrn } : {},
        q.merchant_id ? { merchantId: q.merchant_id } : {},
        q.reseller_id ? { resellerId: q.reseller_id } : {},
        q.provider_id && internal ? { providerId: q.provider_id } : {},
        q.amount_min !== undefined || q.amount_max !== undefined ? { amountMinor: { ...(q.amount_min !== undefined ? { gte: q.amount_min } : {}), ...(q.amount_max !== undefined ? { lte: q.amount_max } : {}) } } : {},
        q.created_from || q.created_to ? { createdAt: { ...(q.created_from ? { gte: new Date(q.created_from) } : {}), ...(q.created_to ? { lt: new Date(q.created_to) } : {}) } } : {},
        cursor
          ? asc
            ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }
            : { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {},
      ],
    };
    const rows = await this.prisma.payment.findMany({
      where: await this.where(actor, filters),
      orderBy: asc ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const codes = internal ? new Map((await this.prisma.provider.findMany({ select: { id: true, code: true } })).map((x) => [x.id, x.code])) : null;
    return toPage(rows, q.limit, (p) => presentPayment(p, { list: true, internal, providerCode: p.providerId ? codes?.get(p.providerId) : null }));
  }

  /** Dashboard metrics: totals and a time series bucketed in IST. */
  async stats(actor: Actor, q: z.output<typeof paymentStatsQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const merchantFilter = q.merchant_id ? [q.merchant_id] : ids;
    const from = new Date(q.from);
    const to = new Date(q.to);
    const unit = q.bucket;
    const rows = await this.prisma.$queryRaw<{ bucket: Date; total: bigint; success: bigint; failed: bigint; success_amount: string | null }[]>`
      SELECT date_trunc(${unit}, created_at AT TIME ZONE 'Asia/Kolkata') AS bucket,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE capture_journal_id IS NOT NULL) AS success,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'EXPIRED')) AS failed,
             SUM(amount_minor) FILTER (WHERE capture_journal_id IS NOT NULL)::text AS success_amount
        FROM payments
       WHERE created_at >= ${from} AND created_at < ${to}
         AND (${merchantFilter === null} OR merchant_id = ANY(${merchantFilter ?? []}::text[]))
       GROUP BY 1 ORDER BY 1`;
    const series = rows.map((r) => ({
      bucket_start: r.bucket,
      count: Number(r.total),
      success_count: Number(r.success),
      failed_count: Number(r.failed),
      success_amount: minorToMajorString(BigInt(r.success_amount ?? '0')),
    }));
    const total = series.reduce((s, r) => s + r.count, 0);
    const success = series.reduce((s, r) => s + r.success_count, 0);
    const failed = series.reduce((s, r) => s + r.failed_count, 0);
    const amount = rows.reduce((s, r) => s + BigInt(r.success_amount ?? '0'), 0n);
    return {
      from,
      to,
      bucket: unit,
      totals: { count: total, success_count: success, failed_count: failed, success_amount: minorToMajorString(amount), success_rate: success + failed ? success / (success + failed) : null },
      series,
    };
  }

  /** Platform review of a held late success: accept captures it now. */
  async acceptLateSuccess(actor: Actor, paymentId: string, reason: string) {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p || !p.requiresReview) throw new AppError(ErrorCode.INVALID_REQUEST, 'Payment is not awaiting review');
    if (p.reviewReason?.startsWith('Provider reported')) throw new AppError(ErrorCode.INVALID_REQUEST, 'Amount mismatches are resolved through reconciliation');
    const result = await this.transitions.apply(paymentId, { status: 'SUCCESS', utr: p.utr ?? undefined, rrn: p.rrn ?? undefined, payerVpa: p.payerVpa ?? undefined, providerTransactionId: p.providerTransactionId ?? undefined }, 'REVIEW', { forceLateAccept: true });
    await this.audit.record({ action: 'payment.late_success_accepted', resourceType: 'payment', resourceId: paymentId, organizationId: p.merchantId, metadata: { reason, result } });
    return this.get(actor, paymentId);
  }
}
