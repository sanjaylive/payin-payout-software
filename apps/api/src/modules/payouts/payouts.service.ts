import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type Beneficiary, isUniqueViolation, type Payout, type Prisma, type PrismaClient, type TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import { type createPayoutSchema, type listPayoutsQuerySchema, MODE_RULES, type paymentStatsQuerySchema, type resolvePayoutReviewSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { LimitsService } from '../limits/limits.service';
import { PricingService } from '../pricing/pricing.service';
import { RoutingService } from '../providers/routing.service';
import { BeneficiariesService } from './beneficiaries.service';
import { PayoutTransitionsService } from './payout-transitions.service';
import { presentPayout } from './payout.presenter';

const IST_OFFSET_MS = 330 * 60_000;

function isLockContention(err: unknown): boolean {
  return err instanceof Error && /55P03|lock timeout|40P01|deadlock detected/.test(`${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})}`);
}
/** Payouts above this need a verified beneficiary (PAYOUT_FLOW.md §3 policy default). */
export const VERIFIED_BENEFICIARY_ABOVE_MINOR = 2_500_000n; // ₹25,000
export const APPROVAL_TTL_MS = 72 * 3600_000;

function istStart(unit: 'day' | 'month', now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const start = unit === 'day' ? Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) : Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1);
  return new Date(start - IST_OFFSET_MS);
}

export interface CreatePayoutOptions {
  source?: 'DASHBOARD' | 'API' | 'BULK';
  bulk?: { batchId: string; rowNo: number; approvalsFloor: number };
}

@Injectable()
export class PayoutsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly scope: TenantScopeService,
    private readonly limits: LimitsService,
    private readonly routing: RoutingService,
    private readonly pricing: PricingService,
    private readonly ledger: LedgerService,
    private readonly beneficiaries: BeneficiariesService,
    private readonly transitions: PayoutTransitionsService,
    private readonly audit: AuditService,
  ) {}

  private async assertMerchantCanPay(merchantId: string) {
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true, payoutEnabled: true, resellerId: true, organization: { select: { status: true } } } });
    if (!m) throw new AppError(ErrorCode.MERCHANT_INACTIVE);
    if (m.status === 'SUSPENDED' || m.organization.status !== 'ACTIVE') throw new AppError(ErrorCode.MERCHANT_INACTIVE, 'Merchant account is suspended');
    if (m.status !== 'APPROVED') throw new AppError(ErrorCode.KYC_NOT_APPROVED, 'Merchant onboarding is not approved yet');
    if (!m.payoutEnabled) throw new AppError(ErrorCode.PAYOUT_DISABLED);
    return m;
  }

  private assertBeneficiaryUsable(b: Beneficiary, mode: keyof typeof MODE_RULES, amountMinor: bigint) {
    if (b.verificationStatus === 'BLOCKED') throw new AppError(ErrorCode.BENEFICIARY_BLOCKED);
    if (b.verificationStatus === 'FAILED') throw new AppError(ErrorCode.BENEFICIARY_NOT_VERIFIED, 'Beneficiary verification failed; correct the details or verify again');
    if (b.verificationStatus !== 'VERIFIED' && amountMinor > VERIFIED_BENEFICIARY_ABOVE_MINOR) {
      throw new AppError(ErrorCode.BENEFICIARY_NOT_VERIFIED, `Verify the beneficiary before paying more than ₹${minorToMajorString(VERIFIED_BENEFICIARY_ABOVE_MINOR)}`);
    }
    const needs = MODE_RULES[mode].needs;
    if (needs === 'UPI' && !b.upiId) throw new AppError(ErrorCode.INVALID_REQUEST, 'UPI payouts need a beneficiary with a UPI ID');
    if (needs === 'ACCOUNT' && !b.accountNumberEncrypted) throw new AppError(ErrorCode.INVALID_REQUEST, `${mode} payouts need a beneficiary with a bank account`);
  }

  /** Daily/monthly limits, evaluated under the merchant AVAILABLE lock so they are exact. */
  private async assertWithinPeriodLimits(tx: TransactionClient, merchantId: string, amountMinor: bigint, l: Awaited<ReturnType<LimitsService['resolveForMerchant']>>) {
    const counted = { merchantId, status: { notIn: ['FAILED', 'REJECTED'] as Payout['status'][] } };
    for (const [unit, amountLimit, countLimit] of [
      ['day', l.dailyAmountMinor.value, l.dailyCount.value],
      ['month', l.monthlyAmountMinor.value, l.monthlyCount.value],
    ] as const) {
      if (amountLimit === null && countLimit === null) continue;
      const agg = await tx.payout.aggregate({ where: { ...counted, createdAt: { gte: istStart(unit) } }, _sum: { amountMinor: true }, _count: true });
      const label = unit === 'day' ? 'daily' : 'monthly';
      if (amountLimit !== null && (agg._sum.amountMinor ?? 0n) + amountMinor > BigInt(amountLimit)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, `Payout ${label} amount limit exceeded`);
      if (countLimit !== null && agg._count + 1 > Number(countLimit)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, `Payout ${label} count limit exceeded`);
    }
  }

  async create(actor: Actor, input: z.output<typeof createPayoutSchema>, rawBody: unknown, idempotencyKey: string | undefined, opts: CreatePayoutOptions = {}) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Payouts are created by merchant accounts');
    const merchantId = actor.organizationId;
    return this.idempotency.run({ merchantId, key: idempotencyKey, method: 'POST', path: '/v1/payouts', body: rawBody }, async (recordId) => {
      // Steps 1–4 before any lock (PAYOUT_FLOW.md §5): cheap checks first.
      const merchant = await this.assertMerchantCanPay(merchantId);
      const l = await this.limits.resolveForMerchant(merchantId, 'PAYOUT');
      if (l.perTxnMinMinor.value !== null && input.amount < BigInt(l.perTxnMinMinor.value)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, 'Payout minimum per-transaction limit not met');
      if (l.perTxnMaxMinor.value !== null && input.amount > BigInt(l.perTxnMaxMinor.value)) throw new AppError(ErrorCode.LIMIT_EXCEEDED, 'Payout maximum per-transaction limit exceeded');

      const beneficiary =
        'beneficiary_id' in input.beneficiary
          ? await this.prisma.beneficiary.findFirst({ where: { id: input.beneficiary.beneficiary_id, merchantId } })
          : (await this.beneficiaries.upsert(this.prisma, merchantId, input.beneficiary, actor.userId)).beneficiary;
      if (!beneficiary) throw new AppError(ErrorCode.NOT_FOUND, 'Beneficiary not found');
      this.assertBeneficiaryUsable(beneficiary, input.mode, input.amount);
      // Risk pre-check (velocity, beneficiary hash fan-out) hooks in here — Phase 10.

      const decision = await this.routing.decide({ service: 'PAYOUT', merchantId, amountMinor: input.amount, method: input.mode });
      const primary = decision.candidates[0];
      if (!primary) throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, `No provider can send ${input.mode} payouts of this amount right now`);
      const quote = await this.pricing.quote({ merchantId, service: 'PAYOUT', method: input.mode, providerId: primary.providerId, amountMinor: input.amount });
      const total = input.amount + quote.merchantFeeMinor + quote.taxMinor;
      // Tier frozen at creation; bulk rows use the stricter of the row and the batch total.
      const approvals = Math.max(await this.limits.approvalsRequiredFor(merchantId, input.amount, 'PAYOUT'), opts.bulk?.approvalsFloor ?? 0);

      const id = newId('payout');
      try {
        const payout = await this.ledger.run(async (tx) => {
          // Everything that needs no lock first; then the short critical section below. Nothing in this
          // transaction may use a second pool connection while holding the merchant lock.
          const created = await tx.payout.create({
            data: {
              id,
              merchantId,
              resellerId: merchant.resellerId,
              merchantOrderId: input.merchant_order_id,
              mode: input.mode,
              purpose: input.purpose,
              source: opts.source ?? 'DASHBOARD',
              amountMinor: input.amount,
              feeMinor: quote.merchantFeeMinor,
              taxMinor: quote.taxMinor,
              totalDebitMinor: total,
              beneficiaryId: beneficiary.id,
              beneficiarySnapshot: this.beneficiaries.snapshot(beneficiary),
              narration: input.narration ?? null,
              metadata: input.metadata,
              approvalsRequired: approvals,
              providerId: primary.providerId,
              routeId: primary.routeId,
              bulkBatchId: opts.bulk?.batchId ?? null,
              bulkRowNo: opts.bulk?.rowNo ?? null,
              createdById: actor.userId,
              requestId: RequestContextStore.get()?.requestId ?? null,
            },
          });
          await this.pricing.snapshot(tx, 'PAYOUT', id, merchantId, quote);
          await this.idempotency.attachResource(tx, recordId, id);
          // Critical section: serialize this merchant's payouts on its AVAILABLE row; period limits
          // and balance are exact under it. Reserve at creation, so an approved payout never bounces.
          await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE code = ${Accounts.merchant(merchantId, 'AVAILABLE')} FOR UPDATE`;
          await this.assertWithinPeriodLimits(tx, merchantId, input.amount, l);
          const journal = await this.ledger.post(tx, {
            type: 'PAYOUT_RESERVE',
            idempotencyKey: `payout:${id}:reserve`,
            source: { type: 'PAYOUT', id },
            description: `Payout ${input.merchant_order_id} reserved`,
            lines: this.transitions.reserveLines(merchantId, total),
          });
          const now = new Date();
          const next = await this.transitions.transition(
            tx,
            created,
            approvals > 0 ? 'APPROVAL_PENDING' : 'QUEUED',
            approvals > 0 ? { reserveJournalId: journal.journalId, approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS) } : { reserveJournalId: journal.journalId, queuedAt: now, nextAttemptAt: now },
          );
          await this.transitions.emit(tx, next, 'payout.created');
          if (next.status === 'QUEUED') await this.transitions.emit(tx, next, 'payout.queued');
          return next;
        });
        return { status: 202, data: presentPayout(payout), resourceId: id };
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_order_id')) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'merchant_order_id has already been used');
        if (isLockContention(err)) {
          // Still contended after bounded retries: nothing was committed. A 5xx releases the
          // idempotency key, so the client can safely retry with the same key.
          throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Too many payouts are being created for this account at once; retry shortly with the same Idempotency-Key');
        }
        throw err;
      }
    });
  }

  // ---- Maker-checker ---------------------------------------------------------------------------

  private async requireMfaSession(actor: Actor) {
    const s = await this.prisma.session.findUnique({ where: { id: actor.sessionId }, select: { mfaVerifiedAt: true } });
    if (!s?.mfaVerifiedAt) {
      throw new AppError(ErrorCode.MFA_ENROLLMENT_REQUIRED, 'Approving payouts needs two-factor authentication. Set it up under Settings → Security, then sign in again.');
    }
  }

  private assertSameMerchant(actor: Actor, p: Payout) {
    // Checkers belong to the payout's own merchant org (platform staff can't approve merchant money).
    if (actor.organizationType !== 'MERCHANT' || actor.organizationId !== p.merchantId) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
  }

  async approve(actor: Actor, payoutId: string, reason?: string) {
    const p0 = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!p0) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    this.assertSameMerchant(actor, p0);
    if (p0.createdById === actor.userId) throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED);
    await this.requireMfaSession(actor);
    const result = await this.prisma.$transaction(async (tx) => {
      const p = await this.transitions.lock(tx, payoutId);
      this.assertSameMerchant(actor, p);
      if (p.status !== 'APPROVAL_PENDING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Payout is ${p.status.toLowerCase().replace('_', ' ')}, not awaiting approval`);
      if (p.createdById === actor.userId) throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED);
      try {
        await tx.payoutApproval.create({ data: { id: newId('payoutApproval'), payoutId, approverId: actor.userId, decision: 'APPROVED', reason: reason ?? null } });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'You have already voted on this payout');
        throw err;
      }
      const received = p.approvalsReceived + 1;
      if (received >= p.approvalsRequired) {
        const now = new Date();
        const next = await this.transitions.transition(tx, p, 'QUEUED', { approvalsReceived: received, queuedAt: now, nextAttemptAt: now });
        await this.transitions.emit(tx, next, 'payout.queued');
        return next;
      }
      const res = await tx.payout.updateMany({ where: { id: p.id, version: p.version, status: 'APPROVAL_PENDING' }, data: { approvalsReceived: received, version: { increment: 1 } } });
      if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Payout changed concurrently');
      return tx.payout.findUniqueOrThrow({ where: { id: p.id } });
    });
    await this.audit.record({ action: 'payout.approved', resourceType: 'payout', resourceId: payoutId, organizationId: result.merchantId, metadata: { approvals: `${result.approvalsReceived}/${result.approvalsRequired}`, queued: result.status === 'QUEUED', reason: reason ?? null } });
    return this.get(actor, payoutId);
  }

  /** Reject (checker) or cancel (maker) a payout awaiting approval; releases the reservation. */
  async reject(actor: Actor, payoutId: string, reason: string) {
    const p0 = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!p0) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    this.assertSameMerchant(actor, p0);
    if (p0.createdById !== actor.userId) await this.requireMfaSession(actor);
    await this.ledger.run(async (tx) => {
      const p = await this.transitions.lock(tx, payoutId);
      if (p.status !== 'APPROVAL_PENDING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Payout is ${p.status.toLowerCase().replace('_', ' ')}, not awaiting approval`);
      try {
        await tx.payoutApproval.create({ data: { id: newId('payoutApproval'), payoutId, approverId: actor.userId, decision: 'REJECTED', reason } });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'You have already voted on this payout');
        throw err;
      }
      const self = p.createdById === actor.userId;
      await this.transitions.release(tx, p, 'REJECTED', { code: self ? 'CANCELLED_BY_MAKER' : 'REJECTED_BY_APPROVER', reason });
    });
    await this.audit.record({ action: 'payout.rejected', resourceType: 'payout', resourceId: payoutId, organizationId: p0.merchantId, metadata: { reason } });
    return this.get(actor, payoutId);
  }

  /** Platform resolution of a payout whose outcome is unknown — needs bank/provider evidence. */
  async resolveReview(actor: Actor, payoutId: string, input: z.output<typeof resolvePayoutReviewSchema>) {
    const p = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!p || p.status !== 'MANUAL_REVIEW') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Payout is not in manual review');
    const result = await this.transitions.apply(payoutId, input.outcome === 'SUCCESS' ? { status: 'SUCCESS', utr: input.utr } : { status: 'FAILED', failureCode: 'MANUAL_REVIEW_FAILED', failureReason: input.reason }, 'REVIEW');
    await this.audit.record({ action: 'payout.review_resolved', resourceType: 'payout', resourceId: payoutId, organizationId: p.merchantId, metadata: { outcome: input.outcome, utr: input.utr ?? null, reason: input.reason, result, severity: 'HIGH' } });
    return this.get(actor, payoutId);
  }

  // ---- Reads -----------------------------------------------------------------------------------

  private async where(actor: Actor, extra: Prisma.PayoutWhereInput = {}): Promise<Prisma.PayoutWhereInput> {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (!ids) return extra;
    if (actor.organizationType === 'RESELLER') return { AND: [{ OR: [{ resellerId: actor.organizationId }, { merchantId: { in: ids } }] }, extra] };
    return { AND: [{ merchantId: { in: ids } }, extra] };
  }

  async get(actor: Actor, payoutId: string) {
    const p = await this.prisma.payout.findFirst({ where: await this.where(actor, { id: payoutId }), include: { attempts: { orderBy: { attemptNo: 'asc' } }, approvals: { orderBy: { createdAt: 'asc' } } } });
    if (!p) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    const internal = actor.organizationType === 'PLATFORM';
    const providerIds = [...new Set([p.providerId, ...p.attempts.map((a) => a.providerId)].filter((x): x is string => Boolean(x)))];
    const codes = new Map((await this.prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, code: true } })).map((x) => [x.id, x.code]));
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: p.approvals.map((a) => a.approverId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const canApprove =
      p.status === 'APPROVAL_PENDING' && actor.organizationType === 'MERCHANT' && actor.permissions.has('payout.approve') && p.createdById !== actor.userId && !p.approvals.some((a) => a.approverId === actor.userId);
    return presentPayout(p, {
      internal,
      providerCode: p.providerId ? codes.get(p.providerId) : null,
      attempts: p.attempts.map((a) => ({ ...a, providerCode: codes.get(a.providerId) })),
      approvals: p.approvals.map((a) => ({ ...a, approverName: names.get(a.approverId) })),
      canApprove,
    });
  }

  async list(actor: Actor, q: z.output<typeof listPayoutsQuerySchema>) {
    if (q.merchant_id) {
      const ids = await this.scope.accessibleOrganizationIds(actor);
      if (ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    }
    const internal = actor.organizationType === 'PLATFORM';
    const cursor = decodeCursor(q.cursor);
    const mine = q.awaiting_my_approval === 'true';
    const filters: Prisma.PayoutWhereInput = {
      AND: [
        q.status ? { status: { in: q.status } } : {},
        q.mode ? { mode: { in: q.mode } } : {},
        q.purpose ? { purpose: q.purpose } : {},
        q.payout_id ? { id: q.payout_id } : {},
        q.merchant_order_id ? { merchantOrderId: q.merchant_order_id } : {},
        q.utr ? { utr: q.utr } : {},
        q.beneficiary_id ? { beneficiaryId: q.beneficiary_id } : {},
        q.merchant_id ? { merchantId: q.merchant_id } : {},
        q.bulk_batch_id ? { bulkBatchId: q.bulk_batch_id } : {},
        mine ? { status: 'APPROVAL_PENDING', NOT: { createdById: actor.userId }, approvals: { none: { approverId: actor.userId } } } : {},
        q.amount_min !== undefined || q.amount_max !== undefined ? { amountMinor: { ...(q.amount_min !== undefined ? { gte: q.amount_min } : {}), ...(q.amount_max !== undefined ? { lte: q.amount_max } : {}) } } : {},
        q.created_from || q.created_to ? { createdAt: { ...(q.created_from ? { gte: new Date(q.created_from) } : {}), ...(q.created_to ? { lt: new Date(q.created_to) } : {}) } } : {},
        cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
      ],
    };
    const rows = await this.prisma.payout.findMany({ where: await this.where(actor, filters), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 });
    const codes = internal ? new Map((await this.prisma.provider.findMany({ select: { id: true, code: true } })).map((x) => [x.id, x.code])) : null;
    return toPage(rows, q.limit, (p) => presentPayout(p, { internal, providerCode: p.providerId ? codes?.get(p.providerId) : null }));
  }

  async stats(actor: Actor, q: z.output<typeof paymentStatsQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const merchantFilter = q.merchant_id ? [q.merchant_id] : ids;
    const rows = await this.prisma.$queryRaw<{ bucket: Date; total: bigint; success: bigint; failed: bigint; success_amount: string | null; pending_approval: bigint }[]>`
      SELECT date_trunc(${q.bucket}, created_at AT TIME ZONE 'Asia/Kolkata') AS bucket,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE settle_journal_id IS NOT NULL) AS success,
             COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
             COUNT(*) FILTER (WHERE status = 'APPROVAL_PENDING') AS pending_approval,
             SUM(amount_minor) FILTER (WHERE settle_journal_id IS NOT NULL)::text AS success_amount
        FROM payouts
       WHERE created_at >= ${new Date(q.from)} AND created_at < ${new Date(q.to)}
         AND (${merchantFilter === null} OR merchant_id = ANY(${merchantFilter ?? []}::text[]))
       GROUP BY 1 ORDER BY 1`;
    const series = rows.map((r) => ({ bucket_start: r.bucket, count: Number(r.total), success_count: Number(r.success), failed_count: Number(r.failed), success_amount: minorToMajorString(BigInt(r.success_amount ?? '0')) }));
    const sum = (k: 'count' | 'success_count' | 'failed_count') => series.reduce((s, r) => s + r[k], 0);
    const success = sum('success_count');
    const failed = sum('failed_count');
    return {
      from: q.from,
      to: q.to,
      bucket: q.bucket,
      totals: {
        count: sum('count'),
        success_count: success,
        failed_count: failed,
        pending_approval_count: rows.reduce((s, r) => s + Number(r.pending_approval), 0),
        success_amount: minorToMajorString(rows.reduce((s, r) => s + BigInt(r.success_amount ?? '0'), 0n)),
        success_rate: success + failed ? success / (success + failed) : null,
      },
      series,
    };
  }
}
