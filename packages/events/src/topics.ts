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

/** Every outbox row is published to `pay2all.<aggregate_type>`, keyed by aggregate id (per-aggregate order). */
export const TOPIC_PREFIX = 'pay2all.';
export function topicFor(aggregateType: string): string {
  return `${TOPIC_PREFIX}${aggregateType.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}
export const dlqTopicFor = (topic: string) => `${topic}.dlq`;

/** Topics provisioned at relay start-up (others are created on first use). */
export const KNOWN_AGGREGATES = ['payment', 'refund', 'payout', 'settlement', 'notification', 'provider', 'merchant', 'ledger', 'organization', 'user', 'webhook'] as const;

