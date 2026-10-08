import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { ADAPTERS, type NormalizedWebhookEvent } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { type ProviderOutcome, PaymentTransitionsService } from '../payments/payment-transitions.service';
import { RefundsService } from '../payments/refunds.service';
import { PayoutTransitionsService } from '../payouts/payout-transitions.service';

const PAYMENT_STATUS: Record<string, ProviderOutcome['status']> = {
  success: 'SUCCESS', captured: 'SUCCESS', paid: 'SUCCESS',
  failed: 'FAILED', declined: 'FAILED',
  pending: 'PENDING', created: 'PENDING',
  expired: 'EXPIRED',
};
const REFUND_STATUS: Record<string, 'SUCCESS' | 'FAILED'> = { success: 'SUCCESS', processed: 'SUCCESS', failed: 'FAILED' };
const PAYOUT_STATUS: Record<string, 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED'> = {
  accepted: 'PENDING', pending: 'PENDING', processing: 'PENDING',
  success: 'SUCCESS', processed: 'SUCCESS', completed: 'SUCCESS',
  failed: 'FAILED', rejected: 'FAILED',
  reversed: 'REVERSED', returned: 'REVERSED',
};

/**
 * Provider callbacks: verify (raw bytes) → store once → process through the same transition service
 * as polling. Processing failures leave the event FAILED for the retry job; the provider is always
 * acknowledged once the event is safely stored.
 */
@Injectable()
export class InboundEventsService {
  private readonly logger = new Logger(InboundEventsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly transitions: PaymentTransitionsService,
    private readonly refunds: RefundsService,
    private readonly payouts: PayoutTransitionsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async receive(code: string, rawBody: Buffer | undefined, headers: Record<string, string | undefined>) {
    const provider = /^[a-z0-9-]{2,40}$/.test(code) ? await this.prisma.provider.findUnique({ where: { code } }) : null;
    if (!provider || !rawBody) throw new AppError(ErrorCode.NOT_FOUND);
    const factory = ADAPTERS[provider.adapter];
    const ctx = await this.registry.context(provider);
    const adapter = factory?.payin?.(ctx) ?? factory?.payout?.(ctx);
    if (!adapter) throw new AppError(ErrorCode.NOT_FOUND);

    const verification = adapter.verifyWebhook(rawBody, headers);
    if (!verification.valid || !verification.event) {
      this.logger.warn({ provider: code, reason: verification.reason }, 'Rejected provider webhook');
      await this.audit.record({ action: 'provider.webhook.rejected', resourceType: 'provider', resourceId: provider.id, organizationId: null, actor: { type: 'SYSTEM', id: null }, metadata: { reason: verification.reason, severity: 'MEDIUM' } });
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    }
    const e = verification.event;
    const id = newId('providerWebhook');
    try {
      await this.prisma.providerWebhookEvent.create({
        data: {
          id,
          providerId: provider.id,
          externalEventId: e.externalEventId,
          eventType: e.type,
          signatureValid: true,
          payload: JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue,
          requestId: RequestContextStore.get()?.requestId ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { received: true, duplicate: true };
      throw err;
    }
    await this.process(id).catch((err: unknown) => this.logger.error({ err, eventId: id }, 'Inbound event processing failed; will retry'));
    return { received: true, duplicate: false };
  }

  async process(eventId: string): Promise<void> {
    const ev = await this.prisma.providerWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (ev.status === 'PROCESSED' || ev.status === 'IGNORED') return;
    const e = ev.payload as unknown as Omit<NormalizedWebhookEvent, 'amountMinor'> & { amountMinor?: string };
    const mark = (status: 'PROCESSED' | 'IGNORED', error?: string) =>
      this.prisma.providerWebhookEvent.update({ where: { id: eventId }, data: { status, error: error ?? null, processedAt: new Date() } });

    try {
      if (e.type === 'payment.status') {
        const payment = await this.prisma.payment.findFirst({
          where: { providerId: ev.providerId, OR: [...(e.providerOrderId ? [{ providerOrderId: e.providerOrderId }] : []), ...(e.reference ? [{ id: e.reference }] : [])] },
          select: { id: true },
        });
        const status = PAYMENT_STATUS[e.status.toLowerCase()];
        if (!payment) return void (await mark('IGNORED', 'Unknown payment (reconciliation will flag it)'));
        if (e.confirmByStatusApi) {
          // The callback can't be trusted for the outcome: have the poller ask the provider now.
          await this.prisma.payment.updateMany({ where: { id: payment.id, status: { in: ['CREATED', 'PENDING'] } }, data: { nextPollAt: new Date() } });
          return void (await mark('PROCESSED'));
        }
        if (!status) return void (await mark('IGNORED', `Unrecognised status ${e.status}`));
        await this.ledger.run(async (tx) => {
          await this.transitions.applyOutcome(
            tx,
            payment.id,
            { status, amountMinor: e.amountMinor ? BigInt(e.amountMinor) : undefined, utr: e.utr, rrn: e.rrn, payerVpa: e.payerVpa, failureReason: e.failureReason },
            'CALLBACK',
          );
          await tx.providerWebhookEvent.update({ where: { id: eventId }, data: { status: 'PROCESSED', error: null, processedAt: new Date() } });
        });
        return;
      }
      if (e.type === 'refund.status') {
        const refund = e.reference ? await this.prisma.refund.findFirst({ where: { id: e.reference, providerId: ev.providerId }, select: { id: true } }) : null;
        const status = REFUND_STATUS[e.status.toLowerCase()];
        if (!refund || !status) return void (await mark('IGNORED', 'Unknown refund or status'));
        await this.refunds.resolve(refund.id, { status, failureReason: e.failureReason });
        await mark('PROCESSED');
        return;
      }
      if (e.type === 'payout.status') {
        // Match on the provider's reference, else on our attempt reference (`pout_X-n`), within this provider.
        const attempt = await this.prisma.payoutAttempt.findFirst({
          where: { providerId: ev.providerId, OR: [...(e.providerReference ? [{ providerReference: e.providerReference }] : []), ...(e.reference ? [{ reference: e.reference }] : [])] },
          select: { payoutId: true },
        });
        const status = PAYOUT_STATUS[e.status.toLowerCase()];
        if (!attempt) return void (await mark('IGNORED', 'Unknown payout (reconciliation will flag it)'));
        if (!status) return void (await mark('IGNORED', `Unrecognised status ${e.status}`));
        await this.ledger.run(async (tx) => {
          await this.payouts.applyOutcome(tx, attempt.payoutId, { status, utr: e.utr, providerReference: e.providerReference, failureReason: e.failureReason }, 'CALLBACK');
          await tx.providerWebhookEvent.update({ where: { id: eventId }, data: { status: 'PROCESSED', error: null, processedAt: new Date() } });
        });
        return;
      }
      await mark('IGNORED', `Unsupported event type ${String(e.type)}`);
    } catch (err) {
      await this.prisma.providerWebhookEvent.update({ where: { id: eventId }, data: { status: 'FAILED', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) } });
      throw err;
    }
  }

  /** Retry stored events that failed or were never processed (job). */
  async retryPending(limit = 50): Promise<number> {
    const due = await this.prisma.providerWebhookEvent.findMany({
      where: { status: { in: ['RECEIVED', 'FAILED'] }, receivedAt: { lt: new Date(Date.now() - 30_000), gt: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const { id } of due) await this.process(id).catch(() => undefined);
    return due.length;
  }
}
