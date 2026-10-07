import { Injectable, Logger } from '@nestjs/common';
import type { Payout, PayoutStatus, Prisma, TransactionClient } from '@pay2all/database';
import { Accounts, type PostingLine } from '@pay2all/ledger/engine';
import { ErrorCode, payoutCanTransition } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { MerchantEventsService, type MerchantEventType } from '../../infra/merchant-events.service';
import { AuditService } from '../audit/audit.service';
import { PAYOUT_UNCOUNTED, PeriodUsageService } from '../limits/period-usage.service';
import { LedgerService } from '../ledger/ledger.service';
import { presentPayout } from './payout.presenter';

export interface PayoutOutcome {
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED';
  utr?: string;
  providerReference?: string;
  failureCode?: string;
  failureReason?: string;
  completedAt?: Date;
}
export type PayoutOutcomeSource = 'PROCESSOR' | 'POLL' | 'CALLBACK' | 'SANDBOX' | 'REVIEW';
export type PayoutTransitionResult = 'APPLIED' | 'NOOP' | 'DUPLICATE' | 'MISMATCH';

const IN_FLIGHT: PayoutStatus[] = ['PROCESSING', 'PENDING'];

/**
 * The only code that changes a payout's lifecycle or moves its money (docs/PAYOUT_FLOW.md §8, §10).
 * Every method runs on the caller's ledger transaction with the payout row locked, so a status
 * change and its journal commit together or not at all. Journal idempotency keys are per payout
 * (`payout:<id>:settle|release|reversal`), so a replay can never post twice.
 */
@Injectable()
export class PayoutTransitionsService {
  private readonly logger = new Logger(PayoutTransitionsService.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly events: MerchantEventsService,
    private readonly audit: AuditService,
    private readonly usage: PeriodUsageService,
  ) {}

  async lock(tx: TransactionClient, id: string): Promise<Payout> {
    await tx.$queryRaw`SELECT id FROM payouts WHERE id = ${id} FOR UPDATE`;
    const p = await tx.payout.findUnique({ where: { id } });
    if (!p) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    return p;
  }

  async transition(tx: TransactionClient, p: Payout, to: PayoutStatus, data: Prisma.PayoutUncheckedUpdateManyInput = {}): Promise<Payout> {
    if (!payoutCanTransition(p.status, to)) {
      this.logger.error({ payoutId: p.id, from: p.status, to }, 'Rejected invalid payout transition');
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Payout cannot move from ${p.status} to ${to}`);
    }
    const res = await tx.payout.updateMany({ where: { id: p.id, status: p.status, version: p.version }, data: { ...data, status: to, version: { increment: 1 } } });
    if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Payout changed concurrently');
    // Failed/rejected payouts stop counting towards daily/monthly limits (same transaction).
    if (!PAYOUT_UNCOUNTED.has(p.status) && PAYOUT_UNCOUNTED.has(to)) await this.usage.release(tx, p.merchantId, 'PAYOUT', p.amountMinor, p.createdAt);
    return tx.payout.findUniqueOrThrow({ where: { id: p.id } });
  }

  emit(tx: TransactionClient, p: Payout, type: MerchantEventType) {
    return this.events.emit(tx, p.merchantId, type, p.id, presentPayout(p));
  }

  // ---- Journals -----------------------------------------------------------------------------------

  reserveLines(merchantId: string, total: bigint): PostingLine[] {
    return [
      { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'DEBIT', amountMinor: total, currency: 'INR' },
      { accountCode: Accounts.merchant(merchantId, 'RESERVED'), direction: 'CREDIT', amountMinor: total, currency: 'INR' },
    ];
  }

  private async providerCode(tx: TransactionClient, p: Payout) {
    if (!p.providerId) throw new Error(`Payout ${p.id} has no provider`);
    return (await tx.provider.findUniqueOrThrow({ where: { id: p.providerId }, select: { code: true } })).code;
  }

  /** RESERVED → AVAILABLE (reject, definitive failure, approval expiry). */
  async release(tx: TransactionClient, p: Payout, to: 'FAILED' | 'REJECTED', why: { code: string; reason: string }): Promise<Payout> {
    const journal = await this.ledger.post(tx, {
      type: 'PAYOUT_RELEASE',
      idempotencyKey: `payout:${p.id}:release`,
      source: { type: 'PAYOUT', id: p.id },
      description: `Payout ${p.merchantOrderId} ${to.toLowerCase()}`,
      lines: [
        { accountCode: Accounts.merchant(p.merchantId, 'RESERVED'), direction: 'DEBIT', amountMinor: p.totalDebitMinor, currency: 'INR' },
        { accountCode: Accounts.merchant(p.merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: p.totalDebitMinor, currency: 'INR' },
      ],
    });
    const next = await this.transition(tx, p, to, { releaseJournalId: journal.journalId, failureCode: why.code, failureReason: why.reason, nextAttemptAt: null, processedAt: new Date() });
    await this.emit(tx, next, to === 'FAILED' ? 'payout.failed' : 'payout.rejected');
    return next;
  }

  /** RESERVED → provider clearing (principal) + fee revenue + GST: money has left. */
  private async settle(tx: TransactionClient, p: Payout, o: PayoutOutcome): Promise<Payout> {
    const code = await this.providerCode(tx, p);
    const lines: PostingLine[] = [
      { accountCode: Accounts.merchant(p.merchantId, 'RESERVED'), direction: 'DEBIT', amountMinor: p.totalDebitMinor, currency: 'INR' },
      { accountCode: Accounts.providerClearing(code), direction: 'CREDIT', amountMinor: p.amountMinor, currency: 'INR' },
    ];
    if (p.feeMinor > 0n) lines.push({ accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: p.feeMinor, currency: 'INR' });
    if (p.taxMinor > 0n) lines.push({ accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: p.taxMinor, currency: 'INR' });
    const journal = await this.ledger.post(tx, { type: 'PAYOUT_SETTLE', idempotencyKey: `payout:${p.id}:settle`, source: { type: 'PAYOUT', id: p.id }, description: `Payout ${p.merchantOrderId}`, metadata: { utr: o.utr ?? '' }, lines });
    const next = await this.transition(tx, p, 'SUCCESS', {
      settleJournalId: journal.journalId,
      utr: o.utr ?? p.utr,
      providerReference: o.providerReference ?? p.providerReference,
      processedAt: o.completedAt ?? new Date(),
      nextAttemptAt: null,
      failureCode: null,
      failureReason: null,
      reviewReason: null,
    });
    await this.emit(tx, next, 'payout.success');
    return next;
  }

  /**
   * Bank return after success: principal back to AVAILABLE (fee and GST kept unless the payout's
   * pricing snapshot says the fee is refunded). The settle journal is never edited.
   */
  private async reverse(tx: TransactionClient, p: Payout, o: PayoutOutcome): Promise<Payout> {
    const code = await this.providerCode(tx, p);
    const snap = await tx.transactionPricingSnapshot.findUnique({ where: { transactionId: p.id }, select: { refundFee: true } });
    const credit = snap?.refundFee ? p.totalDebitMinor : p.amountMinor;
    const lines: PostingLine[] = [
      { accountCode: Accounts.providerClearing(code), direction: 'DEBIT', amountMinor: p.amountMinor, currency: 'INR' },
      { accountCode: Accounts.merchant(p.merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: credit, currency: 'INR' },
    ];
    if (snap?.refundFee && p.feeMinor > 0n) lines.push({ accountCode: Accounts.FEE_REVENUE, direction: 'DEBIT', amountMinor: p.feeMinor, currency: 'INR' });
    if (snap?.refundFee && p.taxMinor > 0n) lines.push({ accountCode: Accounts.GST_PAYABLE, direction: 'DEBIT', amountMinor: p.taxMinor, currency: 'INR' });
    const journal = await this.ledger.post(tx, {
      type: 'PAYOUT_REVERSAL',
      idempotencyKey: `payout:${p.id}:reversal`,
      source: { type: 'PAYOUT', id: p.id },
      description: `Payout ${p.merchantOrderId} returned by beneficiary bank`,
      metadata: { settle_journal_id: p.settleJournalId ?? '' },
      lines,
    });
    const next = await this.transition(tx, p, 'REVERSED', { reversalJournalId: journal.journalId, reversedAt: new Date(), failureCode: o.failureCode ?? 'RETURNED', failureReason: o.failureReason ?? 'Credit returned by the beneficiary bank' });
    await this.emit(tx, next, 'payout.reversed');
    return next;
  }

  private async mismatch(tx: TransactionClient, p: Payout, o: PayoutOutcome, source: PayoutOutcomeSource): Promise<PayoutTransitionResult> {
    // Ours and the provider's final states disagree: never auto-correct money; flag for recon/ops.
    const reason = `Provider reported ${o.status} for a payout we hold as ${p.status}`;
    await tx.payout.update({ where: { id: p.id }, data: { reviewReason: reason, version: { increment: 1 } } });
    await this.audit.record({ action: 'payout.status_mismatch', resourceType: 'payout', resourceId: p.id, organizationId: p.merchantId, actor: { type: 'SYSTEM', id: null }, metadata: { source, reason, severity: 'CRITICAL' } }, tx);
    return 'MISMATCH';
  }

  /** Apply a provider's answer (processor, poll, callback, sandbox, manual review). Idempotent. */
  async applyOutcome(tx: TransactionClient, payoutId: string, o: PayoutOutcome, source: PayoutOutcomeSource): Promise<PayoutTransitionResult> {
    const p = await this.lock(tx, payoutId);
    // A risk-held payout was never sent, so no provider outcome can apply to it.
    const live = IN_FLIGHT.includes(p.status) || (source === 'REVIEW' && p.status === 'MANUAL_REVIEW' && p.reviewKind !== 'RISK');
    switch (o.status) {
      case 'PENDING': {
        if (p.status !== 'PROCESSING') return 'NOOP';
        const next = await this.transition(tx, p, 'PENDING', { providerReference: o.providerReference ?? p.providerReference });
        await this.emit(tx, next, 'payout.processing');
        return 'APPLIED';
      }
      case 'SUCCESS':
        if (p.status === 'SUCCESS' || p.status === 'REVERSED') return 'DUPLICATE';
        if (!live) return p.status === 'FAILED' ? this.mismatch(tx, p, o, source) : 'NOOP';
        await this.settle(tx, p, o);
        return 'APPLIED';
      case 'FAILED':
        if (p.status === 'FAILED') return 'DUPLICATE';
        if (p.status === 'SUCCESS') return this.mismatch(tx, p, o, source);
        if (!live) return 'NOOP';
        await this.release(tx, p, 'FAILED', { code: o.failureCode ?? 'PAYOUT_FAILED', reason: o.failureReason ?? 'The beneficiary bank rejected the transfer' });
        return 'APPLIED';
      case 'REVERSED': {
        if (p.status === 'REVERSED') return 'DUPLICATE';
        if (p.status === 'FAILED' || p.status === 'REJECTED') return this.mismatch(tx, p, o, source);
        // Never saw the success: the money did leave, then came back — record both legs.
        const settled = live ? await this.settle(tx, p, o) : p.status === 'SUCCESS' ? p : null;
        if (!settled) return 'NOOP';
        await this.reverse(tx, settled, o);
        return 'APPLIED';
      }
    }
  }

  apply(payoutId: string, o: PayoutOutcome, source: PayoutOutcomeSource) {
    return this.ledger.run((tx) => this.applyOutcome(tx, payoutId, o, source));
  }

  ledgerRun<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.ledger.run(work);
  }
}
