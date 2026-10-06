import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { Payout, PayoutAttempt, PrismaClient } from '@pay2all/database';
import { type Candidate, classify, executeWithFailover, FailoverStoppedError, NoProviderAvailableError, type PayoutStatusResult, type ProviderError } from '@pay2all/providers';
import { PRISMA } from '../../infra/tokens';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { RoutingService } from '../providers/routing.service';
import { healthOutcomeOf } from '../payments/payments.service';
import { BeneficiariesService } from './beneficiaries.service';
import { type PayoutOutcome, PayoutTransitionsService } from './payout-transitions.service';

const MAX_PROVIDER_ATTEMPTS = 2;
const MAX_REQUEUES = 10;
/** An INITIATED attempt younger than this may still be mid-call in the processor — don't touch it. */
const IN_CALL_GRACE_MS = 2 * 60_000;
/** Unknown outcome after this long → MANUAL_REVIEW (funds stay reserved). */
export const UNKNOWN_OUTCOME_WINDOW_MS = 24 * 3600_000;
const POLL_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000];
const requeueDelay = (n: number) => Math.min(30_000 * 2 ** n, 15 * 60_000);

export function toOutcome(r: Pick<PayoutStatusResult, 'status' | 'utr' | 'failureCode' | 'failureReason' | 'completedAt'> & { providerReference?: string }): PayoutOutcome {
  return {
    status: r.status === 'ACCEPTED' ? 'PENDING' : r.status,
    utr: r.utr,
    failureCode: r.failureCode,
    failureReason: r.failureReason,
    completedAt: r.completedAt,
    providerReference: r.providerReference,
  };
}

/**
 * Sends queued payouts to providers and resolves in-flight ones (docs/PAYOUT_FLOW.md §7). Runs in
 * the jobs process; every claim is `FOR UPDATE SKIP LOCKED`, so replicas never send the same payout.
 * Core rule: a new provider reference is created only after the previous attempt is *definitively*
 * not sent/failed. Unknown outcomes are looked up, never re-sent blindly.
 */
@Injectable()
export class PayoutProcessorService {
  private readonly logger = new Logger(PayoutProcessorService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly routing: RoutingService,
    private readonly registry: ProviderRegistryService,
    private readonly beneficiaries: BeneficiariesService,
    private readonly transitions: PayoutTransitionsService,
  ) {}

  /**
   * Claim QUEUED payouts (txn A): re-check the merchant, move to PROCESSING. `onlyId` is the Kafka
   * fast path (`payout.queued`); the same claim makes it a no-op if a poller got there first.
   */
  async processQueued(limit = 10, onlyId?: string): Promise<number> {
    const claimed = await this.transitions.ledgerRun(async (tx) => {
      const rows = onlyId
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM payouts WHERE id = ${onlyId} AND status = 'QUEUED' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM payouts WHERE status = 'QUEUED' AND next_attempt_at <= now()
             ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      const ids: string[] = [];
      for (const { id } of rows) {
        const p = await tx.payout.findUniqueOrThrow({ where: { id } });
        const m = await tx.merchant.findUniqueOrThrow({ where: { id: p.merchantId }, select: { status: true, payoutEnabled: true, organization: { select: { status: true } } } });
        if (m.status !== 'APPROVED' || !m.payoutEnabled || m.organization.status !== 'ACTIVE') {
          await this.transitions.release(tx, p, 'REJECTED', { code: 'MERCHANT_PAYOUTS_DISABLED', reason: 'Payouts were disabled for this account before the transfer was sent' });
          continue;
        }
        await this.transitions.transition(tx, p, 'PROCESSING', { nextAttemptAt: new Date(Date.now() + IN_CALL_GRACE_MS) });
        ids.push(id);
      }
      return ids;
    });
    for (const id of claimed) {
      await this.send(id).catch((err: unknown) => this.logger.error({ err, payoutId: id }, 'Payout send failed unexpectedly; the sweeper will resolve it'));
    }
    return claimed.length;
  }

  private async send(payoutId: string): Promise<void> {
    const p = await this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { beneficiary: true } });
    const decision = await this.routing.decide({ service: 'PAYOUT', merchantId: p.merchantId, amountMinor: p.amountMinor, method: p.mode });
    const candidates = decision.candidates.slice(0, MAX_PROVIDER_ATTEMPTS);
    if (candidates.length === 0) return this.requeue(p, 'No eligible provider');
    const b = p.beneficiary;
    const priorAttempts = await this.prisma.payoutAttempt.count({ where: { payoutId } });
    try {
      const { result } = await executeWithFailover(
        candidates,
        async (c: Candidate, i: number) => {
          const attemptNo = priorAttempts + i;
          const reference = `${p.id}-${attemptNo}`;
          // Committed BEFORE the call: if we crash mid-call the sweeper sees an INITIATED attempt
          // and looks the reference up instead of sending again.
          const attempt = await this.prisma.payoutAttempt.create({ data: { id: newId('payoutAttempt'), payoutId, attemptNo, providerId: c.providerId, reference } });
          await this.prisma.payout.updateMany({ where: { id: payoutId, status: 'PROCESSING' }, data: { providerId: c.providerId, routeId: c.routeId } });
          const started = Date.now();
          try {
            const { adapter } = await this.registry.payout(c.providerId);
            const res = await adapter.createPayout({
              reference,
              amountMinor: p.amountMinor,
              currency: 'INR',
              mode: p.mode as 'IMPS',
              purpose: p.purpose,
              narration: p.narration ?? undefined,
              beneficiary: { name: b.name, ...(b.upiId ? { vpa: b.upiId } : { accountNumber: this.beneficiaries.decryptAccount(b), ifsc: b.ifsc! }) },
            });
            const latency = Date.now() - started;
            await this.prisma.payoutAttempt.update({ where: { id: attempt.id }, data: { status: 'ACCEPTED', providerReference: res.providerReference, latencyMs: latency, completedAt: new Date() } });
            await this.registry.recordOutcome(c.providerId, 'PAYOUT', 'SUCCESS', latency);
            return res;
          } catch (raw) {
            const err = classify(raw, c.providerCode);
            const latency = Date.now() - started;
            await this.prisma.payoutAttempt.update({
              where: { id: attempt.id },
              data: { status: err.kind === 'AMBIGUOUS' ? 'UNKNOWN' : 'FAILED', errorKind: err.kind, errorCode: err.code, errorMessage: err.message.slice(0, 300), latencyMs: latency, completedAt: new Date() },
            });
            await this.registry.recordOutcome(c.providerId, 'PAYOUT', healthOutcomeOf(err), latency);
            throw err;
          }
        },
        { maxAttempts: MAX_PROVIDER_ATTEMPTS },
      );
      await this.transitions.apply(payoutId, { status: result.status === 'ACCEPTED' ? 'PENDING' : result.status, providerReference: result.providerReference, utr: result.utr }, 'PROCESSOR');
      await this.schedulePoll(payoutId, 0);
    } catch (err) {
      if (err instanceof FailoverStoppedError) {
        // Outcome unknown at the provider: never try another provider or a new reference.
        this.logger.warn({ payoutId, code: err.providerError.code }, 'Ambiguous provider outcome; will look up by reference');
        return this.schedulePoll(payoutId, 0);
      }
      if (err instanceof NoProviderAvailableError) {
        const rejected = err.attempts.find((a) => a.errorKind === 'REJECTED');
        if (rejected) {
          await this.transitions.apply(payoutId, { status: 'FAILED', failureCode: rejected.errorCode ?? 'REJECTED', failureReason: 'The beneficiary bank or provider rejected the transfer' }, 'PROCESSOR');
          return;
        }
        return this.requeue(p, 'Providers unreachable');
      }
      throw err;
    }
  }

  private async schedulePoll(payoutId: string, n: number) {
    await this.prisma.payout.updateMany({ where: { id: payoutId, status: { in: ['PROCESSING', 'PENDING'] } }, data: { nextAttemptAt: new Date(Date.now() + POLL_BACKOFF_MS[Math.min(n, POLL_BACKOFF_MS.length - 1)]!) } });
  }

  /** Every attempt provably never reached a provider: back to QUEUED (or fail after many tries). */
  private async requeue(p: Payout, why: string) {
    await this.transitions.ledgerRun(async (tx) => {
      const cur = await this.transitions.lock(tx, p.id);
      if (cur.status !== 'PROCESSING') return;
      const open = await tx.payoutAttempt.count({ where: { payoutId: p.id, status: { in: ['INITIATED', 'UNKNOWN', 'ACCEPTED'] } } });
      if (open > 0) return; // something may have been sent — leave it to the sweeper
      if (cur.requeueCount + 1 >= MAX_REQUEUES) {
        await this.transitions.release(tx, cur, 'FAILED', { code: 'PROVIDER_UNAVAILABLE', reason: 'No payout provider was reachable; funds returned to your balance' });
        return;
      }
      await this.transitions.transition(tx, cur, 'QUEUED', { requeueCount: { increment: 1 }, nextAttemptAt: new Date(Date.now() + requeueDelay(cur.requeueCount)) });
    });
    this.logger.warn({ payoutId: p.id, why }, 'Payout requeued');
  }

  /** Status sweeper for PROCESSING/PENDING payouts: polls, recovers crashes, escalates unknowns. */
  async pollInFlight(limit = 25): Promise<number> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; poll_count: number }[]>`
        SELECT id, poll_count FROM payouts WHERE status IN ('PROCESSING', 'PENDING') AND next_attempt_at <= now()
         ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        await tx.payout.update({ where: { id: r.id }, data: { pollCount: { increment: 1 }, nextAttemptAt: new Date(Date.now() + POLL_BACKOFF_MS[Math.min(r.poll_count + 1, POLL_BACKOFF_MS.length - 1)]!) } });
      }
      return rows.map((r) => r.id);
    });
    for (const id of claimed) await this.resolve(id).catch((err: unknown) => this.logger.warn({ err, payoutId: id }, 'Payout status check failed; will retry'));
    return claimed.length;
  }

  private async lookup(attempt: PayoutAttempt): Promise<{ result?: PayoutStatusResult; notFound?: boolean; error?: ProviderError }> {
    const { adapter, provider } = await this.registry.payout(attempt.providerId);
    const started = Date.now();
    try {
      const result = await adapter.getPayoutStatus(attempt.providerReference ?? attempt.reference);
      await this.registry.recordOutcome(provider.id, 'PAYOUT', 'SUCCESS', Date.now() - started);
      return { result };
    } catch (raw) {
      const err = classify(raw, provider.code);
      await this.registry.recordOutcome(provider.id, 'PAYOUT', healthOutcomeOf(err), Date.now() - started);
      if (err.kind === 'REJECTED' && /NOT_FOUND/i.test(err.code)) return { notFound: true };
      return { error: err };
    }
  }

  private async resolve(payoutId: string) {
    const p = await this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    const attempt = await this.prisma.payoutAttempt.findFirst({ where: { payoutId }, orderBy: { attemptNo: 'desc' } });
    if (!attempt) {
      // Crashed between claim and the first attempt insert: provably nothing sent.
      if (p.status === 'PROCESSING' && p.updatedAt.getTime() < Date.now() - IN_CALL_GRACE_MS) await this.requeue(p, 'Recovered after a crash before sending');
      return;
    }
    if (attempt.status === 'INITIATED' && attempt.createdAt.getTime() > Date.now() - IN_CALL_GRACE_MS) return;
    if (attempt.status === 'FAILED') {
      // Definitive failure recorded but the payout never moved on (crash after the attempt update).
      if (p.status === 'PROCESSING') await this.requeue(p, 'Recovered after a definitive attempt failure');
      return;
    }
    const { result, notFound } = await this.lookup(attempt);
    if (result) {
      if (!attempt.providerReference) await this.prisma.payoutAttempt.update({ where: { id: attempt.id }, data: { status: 'ACCEPTED', providerReference: result.providerReference } });
      await this.transitions.apply(payoutId, toOutcome({ ...result, providerReference: result.providerReference }), 'POLL');
      return;
    }
    if (notFound && attempt.status !== 'ACCEPTED') {
      const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: attempt.providerId } });
      const lookupGuaranteed = (provider.capabilities as { supports_reference_lookup?: boolean } | null)?.supports_reference_lookup === true;
      if (lookupGuaranteed) {
        // The provider guarantees reference lookup and has never seen it: re-send with the SAME reference.
        this.logger.warn({ payoutId, reference: attempt.reference }, 'Re-sending payout with the same reference after NOT_FOUND');
        const { adapter } = await this.registry.payout(attempt.providerId);
        const full = await this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { beneficiary: true } });
        const b = full.beneficiary;
        const res = await adapter.createPayout({ reference: attempt.reference, amountMinor: p.amountMinor, currency: 'INR', mode: p.mode as 'IMPS', purpose: p.purpose, narration: p.narration ?? undefined, beneficiary: { name: b.name, ...(b.upiId ? { vpa: b.upiId } : { accountNumber: this.beneficiaries.decryptAccount(b), ifsc: b.ifsc! }) } });
        await this.prisma.payoutAttempt.update({ where: { id: attempt.id }, data: { status: 'ACCEPTED', providerReference: res.providerReference } });
        await this.transitions.apply(payoutId, { status: res.status === 'ACCEPTED' ? 'PENDING' : res.status, providerReference: res.providerReference, utr: res.utr }, 'POLL');
        return;
      }
    }
    if (attempt.createdAt.getTime() < Date.now() - UNKNOWN_OUTCOME_WINDOW_MS) await this.escalate(p, 'Provider outcome unknown after 24 hours — check the bank statement before resolving');
  }

  private async escalate(p: Payout, reason: string) {
    await this.transitions.ledgerRun(async (tx) => {
      const cur = await this.transitions.lock(tx, p.id);
      if (cur.status !== 'PROCESSING' && cur.status !== 'PENDING') return;
      await this.transitions.transition(tx, cur, 'MANUAL_REVIEW', { reviewReason: reason, nextAttemptAt: null });
    });
    this.logger.error({ payoutId: p.id }, 'Payout moved to manual review (unknown outcome)');
  }

  /** Approval timeout (default 72 h): reject and release the reservation. */
  async expireApprovals(limit = 50): Promise<number> {
    const due = await this.prisma.payout.findMany({ where: { status: 'APPROVAL_PENDING', approvalExpiresAt: { lt: new Date() } }, select: { id: true }, take: limit });
    for (const { id } of due) {
      await this.transitions.ledgerRun(async (tx) => {
        const p = await this.transitions.lock(tx, id);
        if (p.status !== 'APPROVAL_PENDING') return;
        await this.transitions.release(tx, p, 'REJECTED', { code: 'APPROVAL_EXPIRED', reason: 'Not approved within 72 hours' });
      });
    }
    return due.length;
  }
}
