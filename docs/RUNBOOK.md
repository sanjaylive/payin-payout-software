# Runbook

First steps for each alert in `infra/prometheus/alerts.yml`. Every action that touches money (resolving payouts, releasing holds, re-enabling services) goes through the dashboard, so it is permission-checked and audited. Never edit ledger or transaction rows by hand.

## api-5xx

1. Check the error-reporting project for the top new exceptions (tagged with `route` and `request_id`).
2. `http_server_requests_total{status_class="5xx"}` by `route` shows whether one endpoint or everything is failing.
3. If everything is failing: `/health/ready` on each node. Database or Redis down → follow the provider's incident process; nodes stop receiving traffic automatically.

## latency

1. Check `http_server_request_duration_seconds` by route and `provider_call_duration_seconds`. Payin create time includes the provider call.
2. Check node CPU. A Node.js process is single-threaded; above ~90% CPU, add replicas (perf/RESULTS-2026-10-07.md).
3. Check Postgres: `pg_stat_statements` top statements, and lock waits (`pg_stat_activity` where `wait_event_type = 'Lock'`).

## lock-contention

`ledger_lock_contention_total` counts payout creates that gave up on a merchant's balance lock.

1. Usually one merchant is bursting payouts (bulk upload or an API loop). The 503 tells the client to retry with the same idempotency key; nothing was committed.
2. If it persists, check that merchant's payout rate and approval tier. Contention is per merchant by design.

## provider-down

1. Admin → Providers → Health shows status, success rate and latency. Routing has already failed over to healthy providers where rules allow.
2. Payments that were ambiguous at creation stay CREATED. Pollers and reconciliation resolve them; they are **never** sent to a second provider.
3. Contact the provider. Mark it MAINTENANCE (manual status) if they confirm an outage, so the circuit breaker doesn't flap.

## outbox-backlog

`outbox_oldest_pending_age_seconds` is rising.

1. Is the worker running, and is one replica the relay leader (Redis lease)? Check worker logs for `Outbox publish failed`.
2. Is Kafka reachable? The payout fast path falls back to polling, so money keeps moving. Merchant webhooks and notifications are delayed until the backlog drains.
3. Do not delete outbox rows; they are the source of truth for events.

## dead-letters

1. Admin → Webhooks → Pipeline lists dead-lettered events with the consumer error.
2. Fix the cause (bad endpoint, code bug), then requeue from the same screen. Consumers are idempotent (`processed_events`).

## webhooks

1. Usually one merchant endpoint is down; endpoints auto-disable after 100 consecutive failures and the merchant is notified.
2. Delivery logs per endpoint show status codes and response snippets.

## jobs

1. `job_runs_total{outcome="error"}` names the job. The error report carries the `job` tag.
2. Jobs are idempotent and claim work with `SKIP LOCKED`; a restart is safe.

## risk

- **`RiskEvaluationErrors`:** rules are being skipped (fail open). Check Redis and database health first. Rules resume automatically.
- **`RiskBlocksSpike`:** many declines. Open Admin → Risk → Events, filter by enforced, and identify the rule.
  - A mis-tuned threshold: switch the rule to MONITOR. This is audited, needs a reason, and takes effect within 15s.
  - An attack: leave it enforcing and contact the merchant.
- **Held payouts and disabled services** wait in Admin → Risk → Manual Reviews. Clear or confirm with a note.

## Reports

An export stuck in RUNNING for 30 minutes is re-queued automatically (3 attempts). Repeated failures appear in the jobs error reports with `exportId`.
