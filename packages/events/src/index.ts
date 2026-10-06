/**
 * @pay2all/events — event envelope, topic registry and outbox/consumer contracts.
 * The envelope is defined now so Phase 1 outbox rows already use the final shape (docs/ARCHITECTURE.md §8).
 */
export interface EventEnvelope<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  version: number;
  occurred_at: string;
  request_id: string | null;
  payload: TPayload;
}

export const TOPICS = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_UPDATED: 'payment.updated',
  PAYMENT_SUCCESS: 'payment.success',
  PAYOUT_CREATED: 'payout.created',
  PAYOUT_PROCESS: 'payout.process',
  PAYOUT_UPDATED: 'payout.updated',
  LEDGER_POST: 'ledger.post',
  WEBHOOK_DELIVER: 'webhook.deliver',
  SETTLEMENT_PROCESS: 'settlement.process',
  RECONCILIATION_PROCESS: 'reconciliation.process',
  NOTIFICATION_SEND: 'notification.send',
  RISK_EVALUATE: 'risk.evaluate',
  SECURITY_EVENT: 'security.event',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
