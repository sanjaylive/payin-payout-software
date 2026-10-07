# Observability

There are three processes: `api` (HTTP), `jobs` (the API's background jobs) and `worker` (outbox relay, consumers, webhooks, notifications). Each one emits:
- structured JSON logs (pino, with mandatory redaction);
- Prometheus metrics on an internal port;
- optional OpenTelemetry traces;
- optional Sentry-protocol error reports.

Shared code lives in `packages/telemetry`.

## 1. Logs

- JSON lines with `service`, `env`, `request_id` (the API echoes `X-Request-Id`), `actor_id` and `org_id`.
- Redaction is centralised in `packages/logger`; see SECURITY.md §5.
- When tracing is on, every log line also carries `trace_id` and `span_id`.

## 2. Metrics

| Process | Port setting | Default |
| --- | --- | --- |
| API | `METRICS_PORT` | 9464 |
| Jobs | `JOBS_METRICS_PORT` | 9465 |
| Worker | `WORKER_METRICS_PORT` | 9466 |

Rules for the metrics listener:
- It is **never** the public port; boot validation rejects `METRICS_PORT == PORT`.
- It binds to `METRICS_HOST` (default `127.0.0.1`; use `0.0.0.0` inside containers).
- It can require a bearer token (`METRICS_TOKEN`).
- Only `GET /metrics` is served.
- Labels are bounded: route templates, provider codes, rule codes and enum values. Never ids, amounts or tenant data.

### 2.1 HTTP and business metrics

| Metric | Labels |
| --- | --- |
| `http_server_requests_total`, `http_server_request_duration_seconds` | method, route template, status class |
| `payments_created_total` | method, outcome (created / blocked / provider_failed) |
| `payouts_created_total` | mode, outcome (queued / approval / review / blocked) |
| `provider_calls_total`, `provider_call_duration_seconds` | provider, service, outcome |
| `risk_rule_hits_total` | rule, action, mode |
| `risk_decisions_total` | service, decision |
| `risk_evaluation_errors_total` | rule |
| `ledger_lock_contention_total` | operation |
| `report_exports_total`, `report_export_rows_total` | type, outcome |

### 2.2 Jobs

`job_runs_total{job,outcome}` and `job_run_duration_seconds{job}` cover every scheduled job in both the jobs process and the worker.

### 2.3 Pipeline (worker)

These are refreshed every 15s from the database, so a slow database can never time out a scrape:
- `outbox_pending_events`, `outbox_oldest_pending_age_seconds`, `outbox_published_total`;
- `dead_letter_events_open`;
- `webhook_deliveries_total{outcome}`;
- `notifications_sent_total{channel,outcome}`;
- `provider_health_state{provider,service}`: 0 ACTIVE, 1 DEGRADED, 2 DOWN, 3 MAINTENANCE or DISABLED.

Node.js process metrics (CPU, heap, event-loop lag, GC) come from prom-client's defaults.

## 3. Tracing

Tracing is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Traces are exported over OTLP/HTTP to `…/v1/traces`.

- **Sampling:** parent-based, with `OTEL_TRACES_SAMPLE_RATIO` (default 0.1) for new traces.
- **Instrumented:** HTTP (incoming and outgoing), Express, Postgres (`pg`), Redis (`ioredis`), Kafka (`kafkajs`), and pino (adds the ids to log lines).
- **Load order:** each entry point imports its `instrument` module first, so libraries are patched before they load.
- **Privacy:**
  - Postgres spans carry the parameterised SQL only, never bound values.
  - Redis spans carry the command name only (keys and arguments can hold nonces or session ids).
  - Health and metrics requests are not traced.

## 4. Error reporting

Error reporting is on when `SENTRY_DSN` is set. It works with Sentry or any server that speaks the Sentry protocol (GlitchTip, self-hosted).

What gets reported:
- **API:** unexpected errors only (non-`AppError` or `INTERNAL_ERROR`, status ≥ 500), tagged with request id and route. Deliberate 5xx answers (lock contention, provider unavailable) are not bugs and are not reported.
- **Jobs:** failed scheduled jobs.
- **Worker:** any `error`-level log line that carries an `err`.

What gets stripped before sending:
- request bodies, headers, cookies and query strings;
- user data and breadcrumbs;
- any extra or context key that looks secret (`pass`, `token`, `otp`, `account`, `signature`, …).

Auto-instrumentation is off; OpenTelemetry owns that.

## 5. Alerts

`infra/prometheus/alerts.yml` defines 11 rules (validated with `promtool check rules`), each linking to docs/RUNBOOK.md:

| Area | Alerts |
| --- | --- |
| API | 5xx rate > 2%; payin/payout p95 > 1.5s; lock contention |
| Providers | provider DOWN; provider error rate > 20% |
| Pipeline | outbox backlog > 2 min; dead letters accumulating; webhook failures; job failing repeatedly |
| Risk | evaluation errors (fail-open); unusual block volume |

Thresholds are starting points.

## 6. Running it locally

```bash
docker compose --profile observability up -d   # Prometheus :59090, Jaeger UI :56686, OTLP :54318
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:54318 pnpm dev   # or set it in .env
```

Prometheus scrapes the three host ports through `host.docker.internal`. Admin → System Settings shows which of these features the running deployment has enabled. It shows booleans and labels only, never secrets.
