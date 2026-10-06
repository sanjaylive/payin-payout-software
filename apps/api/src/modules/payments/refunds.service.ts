import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type Payment, type Prisma, type PrismaClient, type Refund, type TransactionClient } from '@pay2all/database';
import { Accounts, type PostingLine } from '@pay2all/ledger/engine';
import { classify, type RefundResult } from '@pay2all/providers';
import { ErrorCode, PAYMENT_CAPTURED_STATUSES } from '@pay2all/types';
import type { createRefundSchema, listRefundsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { PaymentTransitionsService } from './payment-transitions.service';
import { presentRefund } from './payment.presenter';
import { healthOutcomeOf } from './payments.service';

const OPEN_REFUND: Refund['status'][] = ['CREATED', 'PENDING', 'MANUAL_REVIEW'];
const MAX_AMBIGUOUS_ATTEMPTS = 6;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000);

/**
 * Refunds (docs/PAYIN_FLOW.md §8). Created under the payment row lock so concurrent refunds can never
 * exceed the payment; funds move from the merchant (UNSETTLED first, then AVAILABLE) to provider
 * clearing at creation. A definitive provider failure posts the exact reversal; an ambiguous outcome
 * is never reversed blindly — it is retried (same provider reference) and then sent to review.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyService,
    private readonly scope: TenantScopeService,
    private readonly ledger: LedgerService,
    private readonly registry: ProviderRegistryService,
    private readonly transitions: PaymentTransitionsService,
    private readonly events: MerchantEventsService,
  ) {}

  async create(actor: Actor, paymentId: string, input: z.output<typeof createRefundSchema>, rawBody: unknown, idempotencyKey: string | undefined) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Refunds are initiated by the merchant');
    const merchantId = actor.organizationId;
    return this.idempotency.run({ merchantId, key: idempotencyKey, method: 'POST', path: `/v1/payments/${paymentId}/refunds`, body: rawBody }, async (recordId) => {
      try {
        const refund = await this.ledger.run(async (tx) => {
          const owned = await tx.payment.count({ where: { id: paymentId, merchantId } });
          if (!owned) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
          const p = await this.transitions.lock(tx, paymentId);
          if (!PAYMENT_CAPTURED_STATUSES.includes(p.status)) throw new AppError(ErrorCode.REFUND_NOT_ALLOWED, `A ${p.status.toLowerCase()} payment cannot be refunded`);
          const pending = await tx.refund.aggregate({ where: { paymentId, status: { in: OPEN_REFUND } }, _sum: { amountMinor: true } });
          const refundable = p.amountMinor - p.refundedAmountMinor - (pending._sum.amountMinor ?? 0n);
          if (input.amount > refundable) throw new AppError(ErrorCode.REFUND_NOT_ALLOWED, `Amount exceeds the refundable balance of ₹${(refundable / 100n).toString()}.${String(refundable % 100n).padStart(2, '0')}`);

          const id = newId('refund');
          const lines = await this.debitLines(tx, p, input.amount);
          const journal = await this.ledger.post(tx, { type: 'REFUND', idempotencyKey: `refund:${id}`, source: { type: 'REFUND', id }, description: `Refund of ${p.merchantOrderId}`, lines });
          const created = await tx.refund.create({
            data: { id, paymentId, merchantId, merchantRefundId: input.merchant_refund_id ?? null, amountMinor: input.amount, reason: input.reason ?? null, providerId: p.providerId!, journalId: journal.journalId, createdById: actor.userId },
          });
          if (p.status !== 'REFUND_PENDING') await this.transitions.transition(tx, p, 'REFUND_PENDING');
          await this.idempotency.attachResource(tx, recordId, id);
          await this.events.emit(tx, merchantId, 'refund.created', id, presentRefund(created));
          return created;
        });
        return { status: 201, data: presentRefund(refund), resourceId: refund.id };
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_refund_id')) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'merchant_refund_id has already been used');
        throw err;
      }
    });
  }

  /** Draw from UNSETTLED first, then AVAILABLE; the engine re-checks under row locks. */
  private async debitLines(tx: TransactionClient, p: Payment, amount: bigint): Promise<PostingLine[]> {
    const provider = await tx.provider.findUniqueOrThrow({ where: { id: p.providerId! }, select: { code: true } });
    const unsettled = await tx.ledgerAccount.findUnique({ where: { code: Accounts.merchant(p.merchantId, 'UNSETTLED') }, select: { balanceMinor: true } });
    const fromUnsettled = p.settledAt ? 0n : [unsettled?.balanceMinor ?? 0n, amount].reduce((a, b) => (a < b ? a : b));
    const fromAvailable = amount - fromUnsettled;
    const lines: PostingLine[] = [{ accountCode: Accounts.providerClearing(provider.code), direction: 'CREDIT', amountMinor: amount, currency: p.currency }];
    if (fromUnsettled > 0n) lines.push({ accountCode: Accounts.merchant(p.merchantId, 'UNSETTLED'), direction: 'DEBIT', amountMinor: fromUnsettled, currency: p.currency });
    if (fromAvailable > 0n) lines.push({ accountCode: Accounts.merchant(p.merchantId, 'AVAILABLE'), direction: 'DEBIT', amountMinor: fromAvailable, currency: p.currency });
    return lines;
  }

  /** Recompute the payment status once a refund resolves. */
  private async settlePaymentStatus(tx: TransactionClient, paymentId: string) {
    const p = await this.transitions.lock(tx, paymentId);
    if (p.status !== 'REFUND_PENDING') return;
    const open = await tx.refund.count({ where: { paymentId, status: { in: OPEN_REFUND } } });
    if (open > 0) return;
    const next = p.refundedAmountMinor === p.amountMinor ? 'REFUNDED' : p.refundedAmountMinor > 0n ? 'PARTIALLY_REFUNDED' : p.settledAt ? 'SETTLED' : 'SUCCESS';
    await this.transitions.transition(tx, p, next);
  }

  /** Finalise a refund from a provider answer (processor, callback). Idempotent. */
  async resolve(refundId: string, result: { status: 'SUCCESS' | 'FAILED'; providerRefundId?: string; failureReason?: string }) {
    await this.ledger.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId} FOR UPDATE`;
      const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (!OPEN_REFUND.includes(r.status)) return; // already resolved
      if (result.status === 'SUCCESS') {
        const done = await tx.refund.update({ where: { id: r.id }, data: { status: 'SUCCESS', providerRefundId: result.providerRefundId ?? r.providerRefundId, completedAt: new Date(), version: { increment: 1 } } });
        await this.transitions.lock(tx, r.paymentId);
        await tx.payment.update({ where: { id: r.paymentId }, data: { refundedAmountMinor: { increment: r.amountMinor } } });
        await this.settlePaymentStatus(tx, r.paymentId);
        await this.events.emit(tx, r.merchantId, 'refund.success', r.id, presentRefund(done));
      } else {
        // Definitive failure: no money left — return it to the merchant with the exact mirror.
        const original = await tx.ledgerJournal.findUniqueOrThrow({ where: { id: r.journalId! }, include: { entries: { include: { account: { select: { code: true } } } } } });
        const reversal = await this.ledger.post(tx, {
          type: 'REFUND_REVERSAL',
          idempotencyKey: `refund:${r.id}:reversal`,
          source: { type: 'REFUND', id: r.id },
          description: 'Refund failed at provider',
          lines: original.entries.map((e) => ({ accountCode: e.account.code, direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amountMinor: e.amountMinor, currency: e.currency })),
        });
        const failed = await tx.refund.update({ where: { id: r.id }, data: { status: 'FAILED', failureReason: result.failureReason ?? 'Refund failed', reversalJournalId: reversal.journalId, completedAt: new Date(), version: { increment: 1 } } });
        await this.settlePaymentStatus(tx, r.paymentId);
        await this.events.emit(tx, r.merchantId, 'refund.failed', r.id, presentRefund(failed));
      }
    });
  }

  /** Background step: send due refunds to the provider. Safe across replicas (SKIP LOCKED + lease). */
  async processDue(limit = 20): Promise<number> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM refunds WHERE status IN ('CREATED', 'PENDING') AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const { id } of due) {
        await tx.refund.update({ where: { id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
      }
      return due.map((d) => d.id);
    });
    for (const id of claimed) await this.processOne(id).catch((err: unknown) => this.logger.error({ err, refundId: id }, 'Refund processing failed'));
    return claimed.length;
  }

  private async processOne(refundId: string) {
    const r = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
    const started = Date.now();
    let result: RefundResult;
    try {
      const { adapter } = await this.registry.payin(r.providerId);
      // Same reference every time → the provider de-duplicates retries.
      result = await adapter.refundPayment({ reference: r.id, providerOrderId: r.payment.providerOrderId!, providerTransactionId: r.payment.providerTransactionId ?? undefined, amountMinor: r.amountMinor, reason: r.reason ?? undefined });
      await this.registry.recordOutcome(r.providerId, 'PAYIN', 'SUCCESS', Date.now() - started);
    } catch (raw) {
      const err = classify(raw);
      await this.registry.recordOutcome(r.providerId, 'PAYIN', healthOutcomeOf(err), Date.now() - started);
      if (err.kind === 'REJECTED') return this.resolve(r.id, { status: 'FAILED', failureReason: err.message });
      // Not attempted / ambiguous / config: retry with backoff; never reverse money on uncertainty.
      const data: Prisma.RefundUpdateInput =
        r.attempts >= MAX_AMBIGUOUS_ATTEMPTS ? { status: 'MANUAL_REVIEW', failureReason: `Unresolved after ${r.attempts} attempts: ${err.code}` } : { status: 'PENDING', nextAttemptAt: new Date(Date.now() + backoffMs(r.attempts)) };
      await this.prisma.refund.update({ where: { id: r.id }, data });
      return;
    }
    if (result.status === 'PENDING') {
      await this.prisma.refund.update({ where: { id: r.id }, data: { status: 'PENDING', providerRefundId: result.providerRefundId, nextAttemptAt: new Date(Date.now() + backoffMs(r.attempts)) } });
      return;
    }
    await this.resolve(r.id, { status: result.status, providerRefundId: result.providerRefundId, failureReason: result.failureReason });
  }

  // ---- Reads -----------------------------------------------------------------------------------

  async list(actor: Actor, q: z.output<typeof listRefundsQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const rows = await this.prisma.refund.findMany({
      where: {
        AND: [
          ids ? { merchantId: { in: ids } } : {},
          q.merchant_id ? { merchantId: q.merchant_id } : {},
          q.status ? { status: q.status } : {},
          q.payment_id ? { paymentId: q.payment_id } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { payment: { select: { merchantOrderId: true } } },
    });
    return toPage(rows, q.limit, (r) => ({ ...presentRefund(r), merchant_id: r.merchantId, merchant_order_id: r.payment.merchantOrderId, attempts: r.attempts }));
  }
}
