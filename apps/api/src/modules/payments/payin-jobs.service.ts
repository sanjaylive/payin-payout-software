import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@pay2all/database';
import { classify } from '@pay2all/providers';
import { PRISMA } from '../../infra/tokens';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { PaymentTransitionsService } from './payment-transitions.service';
import { presentPayment, presentRefund } from './payment.presenter';
import { healthOutcomeOf } from './payments.service';
import { RefundsService } from './refunds.service';

const POLL_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
const EXPIRY_GRACE_MS = 5 * 60_000;

/**
 * Background work for payins (runs in the jobs process). Every step claims rows with
 * FOR UPDATE SKIP LOCKED so several job replicas never process the same payment twice.
 */
@Injectable()
export class PayinJobsService {
  private readonly logger = new Logger(PayinJobsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly transitions: PaymentTransitionsService,
    private readonly refunds: RefundsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async status(paymentId: string) {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const { adapter } = await this.registry.payin(p.providerId!);
    const started = Date.now();
    try {
      const res = await adapter.getPaymentStatus(p.providerOrderId!, { amountMinor: p.amountMinor });
      await this.registry.recordOutcome(p.providerId!, 'PAYIN', 'SUCCESS', Date.now() - started);
      return res;
    } catch (raw) {
      const err = classify(raw);
      await this.registry.recordOutcome(p.providerId!, 'PAYIN', healthOutcomeOf(err), Date.now() - started);
      throw err;
    }
  }

  /** Ask the provider now (customer just came back from a hosted gateway). Best effort. */
  async checkNow(paymentId: string): Promise<void> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { status: true, providerId: true, providerOrderId: true } });
    if (!p || !p.providerId || !p.providerOrderId || !['CREATED', 'PENDING'].includes(p.status)) return;
    try {
      const res = await this.status(paymentId);
      await this.transitions.apply(paymentId, { status: res.status, amountMinor: res.amountMinor, utr: res.utr, rrn: res.rrn, payerVpa: res.payerVpa, providerTransactionId: res.providerTransactionId, failureReason: res.failureReason, completedAt: res.completedAt }, 'POLL');
    } catch (err) {
      this.logger.warn({ err, paymentId }, 'Return-time status check failed; the poller will retry');
    }
  }

  /** Status poller for open payments without a callback (spaced 1m, 2m, 5m, 10m …). */
  async pollOpenPayments(limit = 50): Promise<number> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; poll_count: number }[]>`
        SELECT id, poll_count FROM payments
         WHERE status IN ('CREATED', 'PENDING') AND next_poll_at <= ${new Date()} AND provider_order_id IS NOT NULL
         ORDER BY next_poll_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        const delay = POLL_BACKOFF_MS[Math.min(r.poll_count + 1, POLL_BACKOFF_MS.length - 1)]!;
        await tx.payment.update({ where: { id: r.id }, data: { pollCount: { increment: 1 }, nextPollAt: new Date(Date.now() + delay) } });
      }
      return rows.map((r) => r.id);
    });
    for (const id of claimed) {
      try {
        const res = await this.status(id);
        await this.transitions.apply(id, { status: res.status, amountMinor: res.amountMinor, utr: res.utr, rrn: res.rrn, payerVpa: res.payerVpa, providerTransactionId: res.providerTransactionId, failureReason: res.failureReason, completedAt: res.completedAt }, 'POLL');
      } catch (err) {
        this.logger.warn({ err, paymentId: id }, 'Payment status poll failed; will retry');
      }
    }
    return claimed.length;
  }

  /** Expire open payments past expires_at + grace, after a final status check. */
  async expireStalePayments(limit = 50): Promise<number> {
    const stale = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; provider_order_id: string | null }[]>`
        SELECT id, provider_order_id FROM payments
         WHERE status IN ('CREATED', 'PENDING') AND expires_at < ${new Date(Date.now() - EXPIRY_GRACE_MS)}
         ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      return rows;
    });
    for (const s of stale) {
      try {
        if (s.provider_order_id) {
          const res = await this.status(s.id);
          if (res.status === 'SUCCESS') {
            await this.transitions.apply(s.id, { status: 'SUCCESS', amountMinor: res.amountMinor, utr: res.utr, rrn: res.rrn, payerVpa: res.payerVpa, providerTransactionId: res.providerTransactionId }, 'EXPIRY');
            continue;
          }
          if (res.status === 'FAILED') {
            await this.transitions.apply(s.id, { status: 'FAILED', failureReason: res.failureReason }, 'EXPIRY');
            continue;
          }
        }
        await this.transitions.apply(s.id, { status: 'EXPIRED', failureReason: s.provider_order_id ? undefined : 'The provider never confirmed the collect request' }, 'EXPIRY');
      } catch (err) {
        // Provider unreachable: don't expire on uncertainty; the next run retries.
        this.logger.warn({ err, paymentId: s.id }, 'Expiry check failed; will retry');
      }
    }
    return stale.length;
  }

  processRefunds() {
    return this.refunds.processDue();
  }

  /**
   * Idempotency hygiene: release keys of requests that died before creating anything, complete keys
   * whose resource exists but whose response was never stored (crash after commit), purge expired.
   */
  async sweepIdempotency(): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({ where: { status: 'IN_PROGRESS', resourceId: null, createdAt: { lt: new Date(Date.now() - 60_000) } } });
    const orphans = await this.prisma.idempotencyRecord.findMany({ where: { status: 'IN_PROGRESS', resourceId: { not: null }, updatedAt: { lt: new Date(Date.now() - 120_000) } }, take: 100 });
    for (const rec of orphans) {
      const id = rec.resourceId!;
      const resource = id.startsWith('pay_')
        ? await this.prisma.payment.findUnique({ where: { id } }).then((p) => p && presentPayment(p))
        : id.startsWith('rfnd_')
          ? await this.prisma.refund.findUnique({ where: { id } }).then((r) => r && presentRefund(r))
          : null;
      if (resource) await this.idempotency.complete(this.prisma, rec.id, 201, { success: true, data: resource });
    }
    await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
