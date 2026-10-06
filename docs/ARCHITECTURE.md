# Pay2All Payments — System Architecture

> Owner: Pay2All Services Pvt. Ltd. · Status: living document · Last reviewed: 2026-10-06

This document is the entry point to the architecture. The other documents go deeper:

| Document | Covers |
| --- | --- |
| [DATABASE.md](./DATABASE.md) | Data model, ID strategy, money columns, indexes, partitioning |
| [SECURITY.md](./SECURITY.md) | AuthN, RBAC, multi-tenancy isolation, API signing, encryption, audit |
| [LEDGER.md](./LEDGER.md) | Double-entry ledger, balance buckets, posting rules, concurrency |
| [PAYIN_FLOW.md](./PAYIN_FLOW.md) | Payin lifecycle, state machine, refunds, ledger postings |
| [PAYOUT_FLOW.md](./PAYOUT_FLOW.md) | Payout lifecycle, reservation, maker-checker, reversal |
| [ROADMAP.md](./ROADMAP.md) | Phased implementation plan and checklist |

## 1. Guiding priorities

When two goals conflict, the earlier item wins:

1. **Financial correctness.** Every money movement is a balanced journal, and nothing is ever double-spent.
2. **Security.** Tenants are isolated, secrets never sit in plaintext, and the platform holds the least privilege it needs.
3. **Auditability.** Who did what, when, from where, and why is recorded append-only.
4. **Idempotency.** Every write that moves money can be retried safely.
5. **Reliability.** A crash at any point leaves the system recoverable without manual ledger surgery.
6. **Scalability.** The target is roughly 1,000 TPS, reached through horizontal scale-out (see §9).
7. **Maintainability.** The code is a modular monolith with clear seams so modules can be extracted later.

### Regulatory posture

The software does **not** assume Pay2All holds any RBI licence and never labels Pay2All an "RBI-authorised Payment Aggregator". Regulated processing and settlement are modelled as being performed **through partners**: sponsor/partner banks, acquiring banks, PSPs and authorised PAs. Which partner does what is configuration (`Provider`, settlement-account mapping), not code. Any licence statement shown in the UI is driven by a configured, legally reviewed value.

## 2. High-level topology

```
                    ┌──────────────────────────┐
  Browser ─────────▶│ apps/web  (Next.js 16)    │  dashboard UI only, no business logic
                    └────────────┬─────────────┘
                                 │ HTTPS (JWT bearer + refresh cookie)
  Merchant servers ─────────────▶│ HTTPS (API key + HMAC signature)
                                 ▼
                    ┌──────────────────────────┐        ┌──────────────┐
                    │ apps/api  (NestJS 11)     │◀──────▶│ Redis        │ rate limits, perm cache,
                    │ stateless, N replicas     │        └──────────────┘ idempotency fast-path
                    │ modular monolith          │
                    └────────────┬─────────────┘
                                 │ single DB transaction:
                                 │ business row + ledger journal + outbox row
                                 ▼
                    ┌──────────────────────────┐
                    │ PostgreSQL (primary)      │──▶ read replica(s) for reports (later)
                    └────────────┬─────────────┘
                                 │ outbox relay (SKIP LOCKED batches)
                                 ▼
                    ┌──────────────────────────┐
                    │ Kafka                     │
                    └────────────┬─────────────┘
                                 ▼
                    ┌──────────────────────────┐        ┌──────────────┐
                    │ apps/worker (NestJS ctx)  │───────▶│ Providers    │ banks / PSPs via adapters
                    │ consumers: payout.process,│        └──────────────┘
                    │ webhook.deliver, settle,  │───────▶ merchant webhook endpoints
                    │ recon, reports, notify    │───────▶ S3 (reports, documents)
                    └──────────────────────────┘
```

## 3. Monorepo layout

Turborepo and pnpm workspaces. Internal packages compile with `tsc` to `dist/` (CommonJS + `.d.ts`). The exception is `packages/ui`, which ships TypeScript source that Next.js transpiles.

```
apps/
  web/       Next.js 16 App Router dashboard (merchant, reseller, admin layouts)
  api/       NestJS 11 HTTP API — dashboard API + public merchant API (/v1)
  worker/    NestJS application context — outbox relay + Kafka consumers + schedulers
  docs/      Developer documentation site (placeholder until the public API stabilises)
packages/
  config/      Shared tsconfig bases, ESLint flat config, Zod env schemas
  types/       Shared types: API envelope, error codes, enums mirrored for the web app
  validation/  Zod request schemas shared by API (validation pipe) and web (forms)
  logger/      Pino logger factory with mandatory redaction rules
  auth/        Password hashing (argon2id), AES-256-GCM field encryption, token helpers,
               permission catalog + system role definitions (single source of truth)
  database/    Prisma 7 schema, migrations, generated client, seed
  ledger/      Money helpers (browser-safe) + `/engine`: pure double-entry posting engine behind a LedgerStore port
  events/      Event envelope, topic registry, outbox/consumer contracts (Phase 7)
  providers/   Provider interfaces + mock/provider-a/provider-b adapters (Phase 4)
  ui/          shadcn/ui-based component library and Pay2All design tokens
docs/          Architecture documents (this folder)
infra/         Docker/infra support files
```

**Dependency rule:** `apps/*` may depend on `packages/*`, and packages never depend on apps. `database` is the only package that talks to PostgreSQL. `ledger` exposes the pure posting engine behind a `LedgerStore` port. The API implements the port with the caller's Prisma transaction client, so a ledger posting always runs **inside the caller's transaction** (see LEDGER.md §10).

## 4. Modular monolith (apps/api)

Each module owns its controllers, services, DTOs, policies and events. Modules communicate only through exported services or domain events, never by reaching into another module's tables.

| Module | Responsibility | Phase |
| --- | --- | --- |
| `core` | config, logging, request context, response envelope, error filter, Prisma, Redis | 1 |
| `auth` | login, MFA, sessions, refresh rotation, password reset | 1 |
| `iam` | organizations, users, roles, permissions, memberships | 1 |
| `audit` | append-only audit log writer + query API | 1 |
| `merchants` / `compliance` | onboarding, KYC/KYB, documents, bank accounts, approvals | 2 |
| `limits` | SYSTEM → RESELLER → MERCHANT limit resolution | 2 |
| `ledger` | accounts, journals, balance service, adjustments | 3 |
| `providers` / `routing` | provider config, credentials, routing engine, health | 4 |
| `pricing` | rate cards, fee computation, pricing snapshots | 5 |
| `payin` / `refunds` | payment creation, status, provider callbacks | 5 |
| `payout` / `beneficiaries` / `approvals` | payouts, reservation, maker-checker | 6 |
| `webhooks` / `outbox` | endpoint config, delivery logs, replay | 7 |
| `settlement` / `reconciliation` | settlement cycles, holds, CSV recon | 8 |
| `resellers` / `api-partners` / `api-keys` | hierarchy, commissions, credentials | 9 |
| `risk` | rule engine, events, actions, manual review | 10 |

**Extraction seam:** a module that must later become a microservice (payout processing and webhook delivery are the likely first candidates) already interacts with the rest of the system through Kafka events and its own tables. Extracting it means moving the module plus its consumers to a new deployable, without a rewrite.

## 5. Request pipeline (apps/api)

```
request
 → RequestContext middleware   requestId (X-Request-Id or generated req_<ulid>), client IP, UA → AsyncLocalStorage
 → helmet / CORS allowlist / body size limit
 → AuthGuard                   JWT (dashboard) — or ApiKeySignatureGuard (public API, Phase 9)
 → TenantContext               resolves actor + organization + accessible org scope from the session, never from the body
 → PermissionGuard             @RequirePermissions('payout.approve') checked against resolved permission set
 → RateLimitGuard              Redis sliding window; per-IP, per-identity and per-merchant policies
 → ZodValidationPipe           strict schemas; unknown keys rejected
 → controller → service (domain logic, transactions, audit, outbox)
 → ResponseEnvelopeInterceptor { success: true, data, meta }
 → AllExceptionsFilter         { success: false, error: { code, message, request_id } }
```

The `requestId` goes into every log line through pino-http and AsyncLocalStorage, every audit row, every outbox event header, every Kafka message header, every provider call (`X-Request-Id` where the provider supports it, always in our logs), and every outgoing merchant webhook (`X-Pay2All-Request-Id`).

### Response envelope and errors

```jsonc
// success
{ "success": true, "data": { }, "meta": { "next_cursor": "…", "has_more": true } }
// error
{ "success": false, "error": { "code": "INSUFFICIENT_BALANCE", "message": "Insufficient available balance", "request_id": "req_01J…" } }
```

Error codes live in `packages/types` (`ErrorCode` enum) with a fixed HTTP status mapping. Internal errors return `INTERNAL_ERROR` with no detail, and the detail goes to logs and Sentry.

**JSON casing:** all external JSON, both dashboard and public API, request and response, uses `snake_case`. Mapping happens explicitly in presenter functions per resource. There is no automatic deep key conversion, so a renamed DB column can never silently change the API contract.

## 6. Multi-tenancy model

- **Organization** is the tenant root. `type ∈ { PLATFORM, RESELLER, API_PARTNER, MERCHANT }`, with an optional `parentId` that forms the hierarchy `PLATFORM → RESELLER → MERCHANT` (API partners hang off PLATFORM or a reseller).
- A **User** belongs to organizations through **memberships** (`UserRole` rows: user × role × organization). A session is bound to exactly one *active* organization.
- **Access scope** is computed server-side from the session:
  - PLATFORM staff: all organizations, further narrowed by permissions.
  - RESELLER users: their reseller org plus its descendant merchants.
  - API_PARTNER users: their own org plus explicitly mapped merchants.
  - MERCHANT users: only their own merchant org.
- Transactional rows (payments, payouts, settlements, …) store `merchantId` **and** a denormalised `resellerId`, copied at creation. Reseller-scoped queries therefore stay single-index lookups and never need recursive joins on the hot path.
- `TenantScopeService` produces a Prisma `where` fragment for the current actor. Repositories **must** compose it, and integration tests assert cross-tenant reads return 404, not 403, so resource existence is never revealed.
- `merchantId`, `organizationId` and `resellerId` in request bodies are **ignored or rejected** for tenant users. Platform staff may target a tenant explicitly through a path parameter, and that access is authorized against the scope and audited.

Details: [SECURITY.md §3](./SECURITY.md#3-multi-tenancy-isolation).

## 7. RBAC

- **Permissions** are fine-grained strings (`payout.approve`). The catalog is defined in code (`packages/auth/src/permissions.ts`) and synced to the `Permission` table by the seed or a migration script.
- **Roles** are bundles of permissions, scoped to an organization type. System roles (`SUPER_ADMIN`, `COMPLIANCE`, `RESELLER`, merchant `OWNER`, `DEVELOPER`, …) are seeded. Custom roles per organization are supported by the schema (`Role.organizationId`).
- Authorization checks **permissions, not role names**: `@RequirePermissions('merchant.approve')`. Role-name checks are banned by lint convention (see SECURITY.md).
- High-risk roles carry `requiresMfa = true`, and sessions for those users cannot reach protected routes until TOTP is verified.
- Resolved permission sets are cached in Redis for 60 s and invalidated whenever role assignments change.

## 8. Event architecture

### Transactional outbox

```
API request
 └─ BEGIN
     ├─ INSERT business row (payout)
     ├─ INSERT ledger journal + entries (reservation)
     ├─ INSERT outbox_events (event_id, type, aggregate, version, payload, headers{request_id})
 └─ COMMIT
worker: outbox relay
 └─ SELECT … FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED
 └─ produce to Kafka (idempotent producer, key = aggregateId → per-aggregate ordering)
 └─ UPDATE outbox_events SET published_at = now()
```

- Delivery is **at-least-once**. Every consumer is idempotent through a `processed_events (consumer_group, event_id)` unique constraint, inserted in the same transaction as the consumer's side effects.
- **Envelope:** `{ event_id, event_type, aggregate_type, aggregate_id, version, occurred_at, request_id, payload }`.
- **Partitioning:** the key is `aggregateId`, which preserves the order of events for one payment or payout. Topics start at 12 partitions.
- **Poison messages:** after N retries, a message goes to `<topic>.dlq` with error metadata, and the dashboard shows DLQ depth.

### Topics (initial)

`payment.created`, `payment.updated`, `payment.success`, `payout.created`, `payout.process`, `payout.updated`, `ledger.post`, `webhook.deliver`, `settlement.process`, `reconciliation.process`, `notification.send`, `risk.evaluate`, `report.generate`.

`ledger.post` exists only for **non-critical, derived** postings such as commission accrual. Postings that affect spendable balance (reservation, payout debit, payin credit) are written **synchronously inside the originating transaction**, never through Kafka.

## 9. Provider architecture

```ts
interface PayinProvider {
  createPayment(req, ctx): Promise<ProviderPaymentResult>;
  getPaymentStatus(ref, ctx): Promise<ProviderPaymentStatus>;
  refundPayment(req, ctx): Promise<ProviderRefundResult>;
  verifyWebhook(rawBody, headers): ProviderWebhookVerification;
}
interface PayoutProvider {
  createPayout(req, ctx): Promise<ProviderPayoutResult>;
  getPayoutStatus(ref, ctx): Promise<ProviderPayoutStatus>;
  verifyBeneficiary(req, ctx): Promise<BeneficiaryVerification>;
  getBalance(ctx): Promise<ProviderBalance>;
}
```

- Adapters live in `packages/providers/{mock,provider-a,provider-b}`. They map provider-specific payloads to normalized results and **never** touch the database.
- Credentials are stored encrypted (`ProviderCredential`, AES-256-GCM with key id). Adapters receive decrypted credentials through a `ProviderContext` at call time, and the logger redacts them.
- **Routing engine:** rules are evaluated in priority order and matched on merchant, reseller, amount slab, method, time window and risk category. The output is an ordered candidate list (PRIMARY → SECONDARY → FALLBACK), filtered by health status and limits.
- **No blind retries on money movement.** A payout is sent to a fallback provider *only* when the primary returned a definitive pre-acceptance failure, such as a connection refused before the request was sent or an explicit "not accepted" code. Timeouts or ambiguous responses move the payout to `PENDING` and status polling or reconciliation takes over. Every provider call carries our attempt ID as the provider idempotency reference where supported.
- **Health:** a rolling window in Redis tracks success rate, timeout rate, and p50/p95/p99 latency, with periodic snapshots to `ProviderHealth`. A circuit breaker moves a provider through `ACTIVE ↔ DEGRADED ↔ DOWN`. `MAINTENANCE` and `DISABLED` are manual states.

## 10. Designing toward ~1,000 TPS

What the design does:

- Stateless API nodes behind a load balancer. All shared state lives in PostgreSQL or Redis.
- The synchronous hot path is as short as possible: validate → idempotency check → one DB transaction → respond. Provider calls for payouts, webhooks, notifications and reports are all asynchronous.
- **Connection pooling:** a pg pool per node, with PgBouncer (transaction mode) in front of PostgreSQL in production. Prisma 7's `@prisma/adapter-pg` uses `node-postgres`, which is compatible with this.
- **Hot-row avoidance in the ledger:** merchant balance rows are locked per merchant, so contention is per tenant. Platform-wide accounts such as fee revenue and provider clearing **do not maintain a locked running balance**. Their balance is aggregated from entries, optionally from sharded sub-accounts. See LEDGER.md §6.
- Composite indexes match the list and filter queries (DATABASE.md §5). Listings use keyset (cursor) pagination, and queries select explicit columns.
- Large tables (`payments`, `payouts`, `ledger_entries`, `webhook_deliveries`, `audit_logs`) are designed for monthly range partitioning on `created_at` once volume warrants it. The schema avoids constraints that would block partitioning later.
- Reports and exports run asynchronously in the worker, stream from a read replica, and write to S3.

What it does **not** claim: the design alone does not prove 1,000 TPS. Throughput must be measured. Phase 10 adds k6 scenarios for payin create, payout create, status reads and the mixed dashboard load, with targets of p95 < 300 ms at the API for writes and zero ledger imbalance or double-spend under concurrency. Results will be recorded in `docs/perf/`.

## 11. Observability

- **Logs:** structured JSON through pino with mandatory redaction paths (passwords, tokens, secrets, OTPs, full account numbers, authorization headers). Every line carries `request_id`, plus `actor_id` and `org_id` when available.
- **Tracing:** OpenTelemetry SDK (HTTP, pg, ioredis, kafkajs instrumentations), exported over OTLP. Trace context propagates into Kafka headers. *(Wired in Phase 10, with hooks in place from Phase 1.)*
- **Metrics:** a Prometheus `/metrics` endpoint (request rate/latency, outbox lag, consumer lag, provider health, ledger posting latency). *(Phase 10.)*
- **Errors:** the exception filter is Sentry-compatible. The SDK is initialised when `SENTRY_DSN` is set, and payloads are scrubbed with the same redaction list.

## 12. Key architecture decisions (ADR summary)

| # | Decision | Rationale |
| --- | --- | --- |
| ADR-1 | Modular monolith + workers, not microservices | One team and one transactional database keep ledger consistency simple. Seams allow extraction later. |
| ADR-2 | Money stored as `BIGINT` minor units (paise) | Exact, fast integer arithmetic in JS `bigint` with no float. Rates are `NUMERIC` with explicit rounding rules. See LEDGER.md §2. |
| ADR-3 | Prefixed ULID string primary keys (`pay_01J…`) | Globally unique, time-sortable, and safe to expose. One ID per entity, with no internal/external mapping table. Provider IDs are separate columns. |
| ADR-4 | Transactional outbox for every domain event | Atomic with the business write, and avoids the "commit then publish" gap. |
| ADR-5 | Spendable-balance postings are synchronous in the originating DB transaction | Balance checks and reservation must be atomic with the payout row. Kafka is never trusted for this. |
| ADR-6 | Ledger immutability enforced in the database (triggers), not only in code | Defence in depth against bugs and ad-hoc SQL. |
| ADR-7 | Zod for validation (shared with web), not class-validator | One schema language across frontend and backend, plus strict unknown-key rejection. |
| ADR-8 | Dashboard auth: short-lived JWT in memory + rotating opaque refresh token in an httpOnly cookie | XSS cannot steal the long-lived credential. Refresh reuse is detected and revokes the whole session. |
| ADR-9 | Permissions resolved server-side per request (cached), not embedded in the JWT | Role changes and revocations take effect within the cache TTL, not at token expiry. |
| ADR-10 | snake_case external JSON with explicit presenters | One stable public contract, decoupled from the DB. |
| ADR-11 | Prisma for CRUD; raw SQL (`$queryRaw` with tagged templates) for locking queries (`FOR UPDATE`, `SKIP LOCKED`) | Prisma has no row-lock API. The raw queries are parameterised and confined to repositories. |
