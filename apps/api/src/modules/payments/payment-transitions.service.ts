import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Payment, PaymentStatus, Prisma, PrismaClient, TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts, type PostingLine } from '@pay2all/ledger/engine';
import { ErrorCode, paymentCanTransition } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import { PAYIN_UNCOUNTED, PeriodUsageService } from '../limits/period-usage.service';
import { LedgerService } from '../ledger/ledger.service';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { presentPayment } from './payment.presenter';

export interface ProviderOutcome {
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
  amountMinor?: bigint;
  providerTransactionId?: string;
  utr?: string;
  rrn?: string;
  payerVpa?: string;
  failureCode?: string;
  failureReason?: string;
  completedAt?: Date;
}

export type TransitionResult = 'APPLIED' | 'NOOP' | 'DUPLICATE' | 'AMOUNT_MISMATCH' | 'HELD_FOR_REVIEW';
export type OutcomeSource = 'CALLBACK' | 'POLL' | 'EXPIRY' | 'SANDBOX' | 'CREATE' | 'REVIEW';

/**
 * The only code path that changes a payment's lifecycle status. Callbacks, the poller, the expiry
 * sweeper and the sandbox all funnel through `applyOutcome` (docs/PAYIN_FLOW.md §6):
 * lock row → validate transition → conditional update → ledger capture → merchant event → outbox.
 */
@Injectable()
export class PaymentTransitionsService {
  private readonly logger = new Logger(PaymentTransitionsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly events: MerchantEventsService,
    private readonly audit: AuditService,
    private readonly usage: PeriodUsageService,
  ) {}

  async lock(tx: TransactionClient, paymentId: string): Promise<Payment> {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    return payment;
  }

  /** Conditional status update; throws INVALID_STATE_TRANSITION if the table forbids it. */
  async transition(tx: TransactionClient, p: Payment, to: PaymentStatus, data: Prisma.PaymentUncheckedUpdateManyInput = {}): Promise<Payment> {
    if (!paymentCanTransition(p.status, to)) {
      this.logger.error({ paymentId: p.id, from: p.status, to }, 'Rejected invalid payment transition');
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Payment cannot move from ${p.status} to ${to}`);
    }
    const updated = await tx.payment.updateMany({ where: { id: p.id, status: p.status, version: p.version }, data: { ...data, status: to, version: { increment: 1 } } });
    if (updated.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Payment changed concurrently');
    // Hosted checkout: the first successful attempt pays the session (same transaction).
    if (to === 'SUCCESS' && p.checkoutSessionId) {
      await tx.checkoutSession.updateMany({ where: { id: p.checkoutSessionId, paymentId: null }, data: { status: 'PAID', paymentId: p.id, paidAt: new Date() } });
    }
    // Keep daily/monthly usage in step with what counts towards limits (same transaction).
    const wasCounted = !PAYIN_UNCOUNTED.has(p.status);
    const isCounted = !PAYIN_UNCOUNTED.has(to);
    if (wasCounted && !isCounted) await this.usage.release(tx, p.merchantId, 'PAYIN', p.amountMinor, p.createdAt);
    else if (!wasCounted && isCounted) await this.usage.add(tx, p.merchantId, 'PAYIN', p.amountMinor, p.createdAt);
    return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
  }

  private captureLines(p: Payment, providerCode: string): PostingLine[] {
    const lines: PostingLine[] = [
      { accountCode: Accounts.providerClearing(providerCode), direction: 'DEBIT', amountMinor: p.amountMinor, currency: p.currency },
      { accountCode: Accounts.merchant(p.merchantId, 'UNSETTLED'), direction: 'CREDIT', amountMinor: p.netAmountMinor, currency: p.currency },
    ];
    if (p.feeMinor > 0n) lines.push({ accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: p.feeMinor, currency: p.currency });
    if (p.taxMinor > 0n) lines.push({ accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: p.taxMinor, currency: p.currency });
    // Scheme commission: the platform pays it on top of the collected amount.
    if (p.commissionMinor > 0n) lines.push({ accountCode: Accounts.MERCHANT_COMMISSION, direction: 'DEBIT', amountMinor: p.commissionMinor, currency: p.currency });
    return lines;
  }

  async applyOutcome(tx: TransactionClient, paymentId: string, outcome: ProviderOutcome, source: OutcomeSource, opts: { forceLateAccept?: boolean } = {}): Promise<TransitionResult> {
    const p = await this.lock(tx, paymentId);

    if (outcome.status === 'PENDING') {
      if (p.status !== 'CREATED') return 'NOOP';
      await this.transition(tx, p, 'PENDING');
      return 'APPLIED';
    }

    if (outcome.status === 'FAILED' || outcome.status === 'EXPIRED') {
      if (p.status !== 'CREATED' && p.status !== 'PENDING') return p.status === outcome.status ? 'DUPLICATE' : 'NOOP';
      const next = await this.transition(tx, p, outcome.status, {
        failedAt: new Date(),
        failureCode: outcome.failureCode ?? (outcome.status === 'EXPIRED' ? 'EXPIRED' : 'PAYMENT_FAILED'),
        failureReason: outcome.failureReason ?? (outcome.status === 'EXPIRED' ? 'The payment window expired' : 'Payment failed'),
        nextPollAt: null,
      });
      await this.events.emit(tx, p.merchantId, 'payment.failed', p.id, presentPayment(next));
      return 'APPLIED';
    }

    // SUCCESS
    if (!['CREATED', 'PENDING', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(p.status)) return 'DUPLICATE';
    if (outcome.amountMinor !== undefined && outcome.amountMinor !== p.amountMinor) {
      // Never capture an amount we didn't ask for: hold for investigation/reconciliation.
      const reason = `Provider reported ₹${minorToMajorString(outcome.amountMinor)} for a ₹${minorToMajorString(p.amountMinor)} payment`;
      await tx.payment.update({ where: { id: p.id }, data: { requiresReview: true, reviewReason: reason, version: { increment: 1 } } });
      await this.audit.record({ action: 'payment.amount_mismatch', resourceType: 'payment', resourceId: p.id, organizationId: p.merchantId, actor: { type: 'SYSTEM', id: null }, metadata: { source, reason, severity: 'HIGH' } }, tx);
      return 'AMOUNT_MISMATCH';
    }

    const late = p.status === 'FAILED' || p.status === 'EXPIRED' || p.status === 'CANCELLED';
    if (late && !opts.forceLateAccept) {
      const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: p.merchantId }, select: { lateSuccessPolicy: true } });
      if (merchant.lateSuccessPolicy === 'MANUAL_REVIEW') {
        await tx.payment.update({
          where: { id: p.id },
          data: { requiresReview: true, reviewReason: `Provider confirmed payment after ${p.status.toLowerCase()} — awaiting review`, utr: outcome.utr ?? p.utr, rrn: outcome.rrn ?? p.rrn, payerVpa: outcome.payerVpa ?? p.payerVpa, providerTransactionId: outcome.providerTransactionId ?? p.providerTransactionId, version: { increment: 1 } },
        });
        await this.audit.record({ action: 'payment.late_success_held', resourceType: 'payment', resourceId: p.id, organizationId: p.merchantId, actor: { type: 'SYSTEM', id: null }, metadata: { source, from: p.status } }, tx);
        return 'HELD_FOR_REVIEW';
      }
    }

    const provider = await tx.provider.findUniqueOrThrow({ where: { id: p.providerId! }, select: { code: true } });
    const next = await this.transition(tx, p, 'SUCCESS', {
      successAt: outcome.completedAt ?? new Date(),
      utr: outcome.utr ?? null,
      rrn: outcome.rrn ?? null,
      payerVpa: outcome.payerVpa ?? null,
      providerTransactionId: outcome.providerTransactionId ?? null,
      lateSuccess: late,
      requiresReview: false,
      reviewReason: null,
      failureCode: null,
      failureReason: null,
      nextPollAt: null,
    });
    // Money exists only now: post the capture in the same transaction (ADR-5), idempotently.
    const journal = await this.ledger.post(tx, {
      type: 'PAYIN_CAPTURE',
      idempotencyKey: `payment:${p.id}:capture`,
      source: { type: 'PAYMENT', id: p.id },
      description: `Payin ${p.merchantOrderId}`,
      metadata: { merchant_order_id: p.merchantOrderId, source, late: String(late) },
      lines: this.captureLines(next, provider.code),
    });
    const final = await tx.payment.update({ where: { id: p.id }, data: { captureJournalId: journal.journalId } });
    await this.events.emit(tx, p.merchantId, 'payment.success', p.id, { ...presentPayment(final), late_success: late });
    return 'APPLIED';
  }

  /** Convenience wrapper running applyOutcome in its own ledger transaction. */
  apply(paymentId: string, outcome: ProviderOutcome, source: OutcomeSource, opts: { forceLateAccept?: boolean } = {}) {
    return this.ledger.run((tx) => this.applyOutcome(tx, paymentId, outcome, source, opts));
  }
}
