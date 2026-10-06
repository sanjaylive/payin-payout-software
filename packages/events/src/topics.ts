/**
 * Event envelope and topic registry. Outbox rows have used this envelope shape since Phase 1
 * (docs/ARCHITECTURE.md §8).
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

/** Every outbox row is published to `pay2all.<aggregate_type>`, keyed by aggregate id (per-aggregate order). */
export const TOPIC_PREFIX = 'pay2all.';
export function topicFor(aggregateType: string): string {
  return `${TOPIC_PREFIX}${aggregateType.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}
export const dlqTopicFor = (topic: string) => `${topic}.dlq`;

/** Topics provisioned at relay start-up (others are created on first use). */
export const KNOWN_AGGREGATES = ['payment', 'refund', 'payout', 'notification', 'provider', 'merchant', 'ledger', 'organization', 'user', 'webhook'] as const;

