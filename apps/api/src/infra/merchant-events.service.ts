import { Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { DbClient, Prisma } from '@pay2all/database';
import { OutboxService } from './outbox.service';

export type MerchantEventType =
  | 'payment.created'
  | 'payment.pending'
  | 'payment.success'
  | 'payment.failed'
  | 'refund.created'
  | 'refund.success'
  | 'refund.failed'
  | 'payout.created'
  | 'payout.queued'
  | 'payout.processing'
  | 'payout.success'
  | 'payout.failed'
  | 'payout.rejected'
  | 'payout.reversed';

/**
 * Records a merchant-facing event (the thing a merchant webhook will carry) and the matching outbox
 * row, in the caller's transaction. Delivery (signing, retries, logs, replay) is the webhook worker's
 * job (Phase 7) — the API never waits on a merchant endpoint.
 */
@Injectable()
export class MerchantEventsService {
  constructor(private readonly outbox: OutboxService) {}

  async emit(tx: DbClient, merchantId: string, type: MerchantEventType, resourceId: string, data: Record<string, unknown>): Promise<string> {
    const id = newId('webhookEvent');
    const payload = JSON.parse(JSON.stringify({ id, type, created_at: new Date().toISOString(), data }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue;
    await tx.webhookEvent.create({ data: { id, merchantId, type, payload, resourceId } });
    await this.outbox.add(tx, { eventType: type, aggregateType: type.split('.')[0]!, aggregateId: resourceId, payload: { event_id: id, merchant_id: merchantId } });
    return id;
  }
}
