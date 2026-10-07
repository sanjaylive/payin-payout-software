import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics (docs/OBSERVABILITY.md §2). One registry per process; every series carries a
 * `service` label (api, jobs, worker). Labels are low-cardinality by construction: route templates
 * (never raw paths), provider codes, rule codes, enum values. Never put ids, amounts or anything
 * tenant-identifying in a label.
 */
export const registry = new Registry();

let initialised = false;
export function initMetrics(service: string): Registry {
  if (initialised) return registry;
  initialised = true;
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const metrics = {
  httpRequests: new Counter({
    name: 'http_server_requests_total',
    help: 'HTTP requests by route template, method and status class',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [registry],
  }),
  httpDuration: new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request latency by route template',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  paymentsCreated: new Counter({
    name: 'payments_created_total',
    help: 'Payin create requests by method and outcome (created, blocked, rejected, error)',
    labelNames: ['method', 'outcome'] as const,
    registers: [registry],
  }),
  payoutsCreated: new Counter({
    name: 'payouts_created_total',
    help: 'Payout create requests by mode and outcome (queued, approval, review, blocked, rejected, error)',
    labelNames: ['mode', 'outcome'] as const,
    registers: [registry],
  }),
  transactionsFinal: new Counter({
    name: 'transactions_final_total',
    help: 'Payins/payouts reaching a final state',
    labelNames: ['kind', 'status'] as const,
    registers: [registry],
  }),
  providerCalls: new Counter({
    name: 'provider_calls_total',
    help: 'Outbound provider calls by provider, service and outcome',
    labelNames: ['provider', 'service', 'outcome'] as const,
    registers: [registry],
  }),
  providerLatency: new Histogram({
    name: 'provider_call_duration_seconds',
    help: 'Outbound provider call latency',
    labelNames: ['provider', 'service'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  providerHealth: new Gauge({
    name: 'provider_health_state',
    help: 'Provider health: 0 = UP, 1 = DEGRADED, 2 = DOWN',
    labelNames: ['provider', 'service'] as const,
    registers: [registry],
  }),
  riskHits: new Counter({
    name: 'risk_rule_hits_total',
    help: 'Risk rule hits by rule, action and mode (ENFORCE / MONITOR)',
    labelNames: ['rule', 'action', 'mode'] as const,
    registers: [registry],
  }),
  riskDecisions: new Counter({
    name: 'risk_decisions_total',
    help: 'Inline risk decisions by service (ALLOW / REVIEW / BLOCK)',
    labelNames: ['service', 'decision'] as const,
    registers: [registry],
  }),
  riskErrors: new Counter({
    name: 'risk_evaluation_errors_total',
    help: 'Risk rules that could not be evaluated (the rule is skipped — fail open)',
    labelNames: ['rule'] as const,
    registers: [registry],
  }),
  lockContention: new Counter({
    name: 'ledger_lock_contention_total',
    help: 'Requests that gave up after bounded retries on a ledger row lock',
    labelNames: ['operation'] as const,
    registers: [registry],
  }),
  jobRuns: new Counter({
    name: 'job_runs_total',
    help: 'Scheduled job runs by job and outcome',
    labelNames: ['job', 'outcome'] as const,
    registers: [registry],
  }),
  jobDuration: new Histogram({
    name: 'job_run_duration_seconds',
    help: 'Scheduled job duration',
    labelNames: ['job'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'outbox_pending_events',
    help: 'Outbox events not yet published to Kafka',
    registers: [registry],
  }),
  outboxOldestAge: new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published to Kafka',
    registers: [registry],
  }),
  webhookDeliveries: new Counter({
    name: 'webhook_deliveries_total',
    help: 'Merchant webhook delivery attempts by outcome (delivered, retry, failed, disabled)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  deadLetters: new Gauge({
    name: 'dead_letter_events_open',
    help: 'Consumer events parked in the dead-letter table and not yet requeued',
    registers: [registry],
  }),
  notificationsSent: new Counter({
    name: 'notifications_sent_total',
    help: 'Notifications by channel and outcome',
    labelNames: ['channel', 'outcome'] as const,
    registers: [registry],
  }),
  reportExports: new Counter({
    name: 'report_exports_total',
    help: 'Report exports by type and outcome',
    labelNames: ['type', 'outcome'] as const,
    registers: [registry],
  }),
  reportRows: new Counter({
    name: 'report_export_rows_total',
    help: 'Rows written to report exports',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
};

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** Time an async job and record its outcome. */
export async function timeJob<T>(job: string, run: () => Promise<T>): Promise<T> {
  const end = metrics.jobDuration.startTimer({ job });
  try {
    const out = await run();
    metrics.jobRuns.inc({ job, outcome: 'ok' });
    return out;
  } catch (err) {
    metrics.jobRuns.inc({ job, outcome: 'error' });
    throw err;
  } finally {
    end();
  }
}
