# Implementation Roadmap & Checklist

Each phase ends with these gates:

- [ ] lint
- [ ] typecheck
- [ ] unit + integration tests green
- [ ] `prisma validate` and migrations applied cleanly on an empty DB
- [ ] docs updated
- [ ] phase summary added to the end of this file

A phase does not start until the previous one passes its gates. If an architecture inconsistency is found, it is fixed first.

Legend: ✅ done · 🟡 in progress · ⬜ not started

## Phase 0 — Architecture & design ✅

- [x] ARCHITECTURE.md: system, monorepo, modules, request pipeline, events, providers, 1,000 TPS plan, ADRs
- [x] DATABASE.md: entity map, conventions, concurrency primitives, indexes, partitioning
- [x] SECURITY.md: auth, RBAC, tenancy, encryption, API/webhook signing, audit
- [x] LEDGER.md: double-entry design, posting recipes, balance service
- [x] PAYIN_FLOW.md / PAYOUT_FLOW.md: lifecycles and state machines

## Phase 1 — Foundation ✅

- [x] Turborepo + pnpm workspace, shared tsconfig/ESLint/Prettier
- [x] Docker Compose: Postgres 17, Redis 7, Kafka (KRaft), SeaweedFS (S3), Mailpit
- [x] `packages/config`: Zod env validation (fails boot on invalid/placeholder secrets in production)
- [x] `packages/logger`: pino JSON logs with mandatory redaction
- [x] `packages/types`: response envelope, `ErrorCode` catalog with HTTP mapping
- [x] `packages/auth`: argon2id hashing, AES-256-GCM envelope encryption, token helpers, permission catalog, system roles
- [x] `packages/validation`: shared Zod schemas (auth, users, pagination)
- [x] `packages/database`: Prisma 7 schema (identity, sessions, MFA, audit, outbox, notifications), migration with append-only triggers, seed
- [x] API core: request ID + AsyncLocalStorage context, response envelope, global exception filter, helmet, CORS, Swagger at `/docs`, health checks
- [x] Auth: login (email/mobile), lockout, Redis rate limits, JWT access, rotating refresh with reuse detection, sessions list/revoke, logout-all, password forgot/reset/change, TOTP MFA (setup/enable/verify/disable), mandatory MFA for privileged roles
- [x] IAM: organizations (scoped), users, memberships, roles, permissions, PermissionGuard, TenantScopeService, privilege-escalation guard
- [x] Audit: append-only writer inside transactions, query API with keyset pagination
- [x] Worker app skeleton (graceful shutdown, health) and docs app placeholder
- [x] Web: Pay2All design tokens (light/dark), shadcn/ui, login, MFA, forgot/reset, merchant and admin shells with full navigation, security settings (sessions, MFA), users, roles, audit logs
- [x] Tests: hashing/crypto/permissions units, auth and RBAC integration (refresh rotation, reuse detection, lockout, cross-tenant 404, permission 403, audit immutability)

## Phase 2 — Merchant & compliance ✅

- [x] Merchant + profile + KYC screening + directors/UBOs (`MerchantPerson`) + bank accounts (encrypted, masked, hashed)
- [x] Onboarding workspace (save drafts section by section; DRAFT → SUBMITTED) with a server-side requirements engine
- [x] Documents: upload through the API (magic-byte sniffing, server sha256, size cap), status workflow, expiry, audited downloads
- [x] Compliance workflow: append-only `compliance_reviews`, reviewer/time/reason/notes, MORE_INFORMATION_REQUIRED loop, four-eyes rules
- [x] Screening status fields (SANCTIONS / PEP / ADVERSE_REVIEW), recorded manually; provider integration later
- [x] Limits (SYSTEM → RESELLER → MERCHANT field-wise resolution) and approval policies (spec tiers seeded)
- [x] Sales CRM: leads, assignment, notes, follow-ups, conversion into merchants
- [x] MFA recovery codes and admin MFA reset
- [x] Admin UI: merchants, pending KYC queue, merchant 360 with review actions, limits & policies, sales leads; reseller merchant views; merchant compliance pages

## Phase 3 — Ledger ✅

- [x] Money helpers (`packages/ledger`): parse/format, fee math (HALF_UP per component), rate micros, clamp, currency registry
- [x] Chart of accounts derived from structured account codes (merchant buckets, reseller commission, platform accounts)
- [x] `postJournal`: validation, journal-type rules, single-merchant invariant, idempotency key + lines hash, sorted row locks, non-negative checks, running `balance_after`
- [x] DB guards: immutability triggers, deferred balanced-journal constraint trigger, currency match, immutable account identity, CHECK non-negative
- [x] Balance service (available, pending, unsettled, reserved, lien, settled to date, receivable) and platform summary
- [x] Reversal journals (once, never a reversal of a reversal, never into negative) and maker-checker manual adjustments
- [x] Balance verification (API on demand + hourly worker job; drift freezes payouts) and daily 00:00 IST `BalanceSnapshot`
- [x] Tests: randomized Debit = Credit / balance invariants, concurrent reserves, duplicate keys, reversal, adjustments, tenancy
- [x] UI: merchant Balance and Ledger statement; admin Accounts, Journals (with reversal), Adjustments, ledger health; live balance cards

## Phase 4 — Providers ✅

- [x] `PayinProvider` / `PayoutProvider` interfaces, normalized result types, error taxonomy (NOT_ATTEMPTED / REJECTED / CONFIGURATION / AMBIGUOUS)
- [x] Classified signed HTTP client; failover executor that never retries ambiguous outcomes elsewhere
- [x] Provider config + write-only encrypted credentials + admin UI (status, credentials, connection test, health history)
- [x] Routing engine (merchant/reseller/method/amount/risk/time window, tiers, health/cost/latency tie-breaks) with explanations and simulator
- [x] Mock payin and payout providers with scriptable outcomes; provider-a / provider-b integration templates
- [x] Provider health: Redis rolling windows, circuit breaker with half-open recovery, single-writer worker job, snapshots
- [x] Inbound provider webhook endpoint (raw-body signature verification, de-duplication)

## Phase 5 — Payin ⬜

- [ ] Pricing engine + `TransactionPricingSnapshot`
- [ ] Idempotency middleware + `IdempotencyRecord`
- [ ] `POST/GET /v1/payments`, list with filters, attempts, QR/intent response
- [ ] Provider callbacks → state machine → ledger → outbox
- [ ] Expiry sweeper, status polling, refunds
- [ ] Dashboard: payin transactions, details drawer, create payment, refunds

## Phase 6 — Payout ⬜

- [ ] Beneficiaries (verification, masking)
- [ ] Payout creation with reservation in a single transaction
- [ ] Maker-checker approvals
- [ ] Payout processor (provider call, attempts, ambiguous-outcome handling)
- [ ] Release/settle/reversal postings
- [ ] Dashboard: make payout, bulk payout, approvals, beneficiaries

## Phase 7 — Kafka + workers ⬜

- [ ] Outbox relay (SKIP LOCKED), idempotent Kafka producer, topic provisioning
- [ ] Consumer framework with `processed_events`, retries, DLQ
- [ ] Webhook delivery worker (signing, backoff, SSRF guard), logs and replay UI
- [ ] Notification worker (email via SMTP; SMS provider later)
- [ ] Move password-reset email from the API to the outbox

## Phase 8 — Settlement & reconciliation ⬜

- [ ] Settlement configs (T0/T1/T2/CUSTOM), generation job, holds
- [ ] Settlement postings and reports
- [ ] Recon runs: CSV import (S3), parsers, matching engine, mismatch dashboard, manual resolution

## Phase 9 — Reseller & API partner ⬜

- [ ] Reseller hierarchy, merchant mapping, rate cards, commission accrual, earnings
- [ ] API partners, API keys (pk/sk, rotation, TEST/LIVE), HMAC signing guard, replay protection, IP allowlist, per-key rate limits
- [ ] API usage dashboard, API logs

## Phase 10 — Risk, observability, hardening ⬜

- [ ] Risk rule engine (velocity, volume spike, shared bank account, beneficiary fan-in, failed attempts, amount anomaly, new-merchant volume), actions, manual review queue
- [ ] OpenTelemetry tracing, Prometheus metrics, Sentry
- [ ] k6 load tests and documented results in `docs/perf/`
- [ ] Security review, RLS on critical tables, index review, partitioning readiness
- [ ] Async report exports (CSV, with an XLSX-ready interface)

## Open decisions (need Pay2All confirmation)

1. **Public API amount format.** The proposal is a string decimal in rupees (`"1000.00"`), with JSON numbers rejected. The alternative is integer paise. This must be decided before Phase 5.
2. **Settlement partner model.** Which partner bank, nodal or escrow arrangement holds merchant funds. This affects the chart of accounts labels, not the structure.
3. **Retention periods** for transactions, audit logs and KYC documents (legal input required).
4. **MFA for merchant OWNER/ADMIN roles.** Currently optional. Recommended to make it mandatory before go-live.

## Phase completion log

### Phase 1 — Foundation (completed 2026-10-06)

**Delivered:** monorepo, infra, shared packages, NestJS API (auth, MFA, sessions, RBAC, tenancy, audit), worker skeleton, Next.js dashboard (merchant/reseller portal + separate admin console).

**Verification:**
- `turbo run lint typecheck test`: 44/44 tasks green (two uncached runs).
- 41 unit tests (config, logger redaction, crypto/argon2/TOTP/RBAC catalog, validation, guards, cursors, error filter).
- 47 API integration tests against real Postgres + Redis: refresh rotation, reuse detection, concurrent refresh, lockout, rate limits, CSRF, MFA enrollment/replay, password reset, cross-tenant 404s, privilege escalation, org suspension, audit immutability.
- Mutation check: disabling session revocation or tenant scoping makes 7 targeted tests fail.
- `prisma validate` passes; migrations apply cleanly to an empty DB; `next build` succeeds.

**Deviations / notes:**
- MinIO no longer publishes public images; local S3 is SeaweedFS (S3 API only, so no code impact).
- Password-reset and invitation emails are sent directly over SMTP (fire-and-forget) until the Phase 7 outbox worker exists.
- Seed covers identity/tenancy only. Providers, payins, payouts, ledger and settlements are seeded by the phases that introduce them.
- Web UI was verified at HTTP level (pages, CSP, CORS, cookie refresh) — interactive browser walkthrough still pending.
- Organization switching for users with multiple memberships is deferred (login uses the earliest active membership).

### Phase 2 — Merchant & compliance (completed 2026-10-06)

**Delivered:**
- **Data and workflow:** a new migration, the merchant aggregate, the onboarding and compliance API with an explicit state machine, and the limits/approval-policy, sales CRM and MFA recovery modules.
- **Money:** helpers in `@pay2all/ledger`.
- **Validation:** Indian identifier validators, including the GSTIN checksum, verified against two published sample GSTINs.
- **UI:** the merchant compliance pages, the admin merchant console and the reseller merchant views.

**Verification:**
- `turbo run lint typecheck test` is green.
- 24 API unit tests, plus package unit tests for money, identifiers and RBAC.
- 65 API integration tests covering:
  - the full DRAFT → APPROVED journey, including the information-request loop;
  - immutability of compliance history;
  - optimistic concurrency (concurrent review start, concurrent lead conversion);
  - four-eyes rules;
  - encrypted storage of PAN and account numbers (nothing in responses or audit logs);
  - file-content sniffing and size caps;
  - audited, byte-exact downloads;
  - cross-tenant 404s;
  - limit and policy tightening-only rules;
  - recovery codes and admin MFA reset.
- **Mutation check:** removing the version guard or the merchant tenant scope fails 3 targeted tests.
- **Role walkthrough:** a merchant owner, compliance and sales walkthrough against the dev servers passed 15 checks, and every new page renders.

**Decisions and notes:**
- KYC uploads go through the API rather than browser-direct pre-signed URLs (SECURITY.md §8).
- Platform staff may attach files during review, for example the countersigned agreement. Applicants are locked out until information is requested.
- Business PAN and GSTIN are stored in plaintext because they are registry data needed for search. Personal PANs and bank account numbers are encrypted.
- Screening and bank verification are recorded manually until provider integrations land (Phase 4+).
- Post-approval profile changes, which need a change-request workflow, are deferred. Bank-account additions after approval are allowed but stay unusable until compliance verifies them, and owners are emailed.
- The browser walkthrough is still pending (the Chrome extension was not connected). Verification was done at the HTTP and API level.

### Phase 3 — Ledger (completed 2026-10-06)

**Delivered:**
- **Engine:** a pure posting engine in `@pay2all/ledger/engine`, with the Prisma store and retrying transaction runner in the API.
- **Migrations:** two new ones, the ledger schema with its DB guards and the adjustment policy reference data.
- **Ledger module:** balances, statements, journals, reversals, maker-checker adjustments, verification and trial balance.
- **Worker:** a scheduler running hourly verification and daily snapshots.
- **UI:** the merchant and admin ledger screens.
- **Seed:** demo ledger history posted through the engine.

**Verification:**
- `turbo run lint typecheck test` is green.
- Ledger package: 19 tests, including 300 randomized postings.
- API: 78 integration tests (13 new ledger tests).
- Worker: unit tests for the IST date math.
- **Spec example:** the payout example posts exactly. The merchant is debited ₹10,005.90; clearing is credited ₹10,000, fees ₹5 and GST ₹0.90.
- **Dev ledger:** zero drift and a zero trial balance. Fee and GST totals match a hand calculation, and the merchant statement reconciles line by line.
- **Mutation:** removing row locks causes a double spend that the concurrency test catches.

**Notes:**
- Demo journals reference `demo_pay_*` and `demo_pout_*` source ids. The Payin and Payout phases will seed the matching transactions.
- Refund, chargeback and settlement *flows* arrive with their phases. Their posting recipes and type rules already exist in the engine.

### Phase 4 — Providers (completed 2026-10-06)

**Delivered:**
- **`@pay2all/providers`:** the contracts, error taxonomy, HTTP client, routing engine, failover executor, health and breaker logic, and the mock, provider-a and provider-b adapters.
- **API:** provider CRUD, manual status, write-only credentials, connection test, routes and routing simulator, and inbound webhooks.
- **Worker:** the provider-health job (the single writer of automatic statuses) and health snapshots.
- **UI:** provider lists, provider detail, routes with the simulator, a health dashboard, and live provider health on the admin dashboard.
- **Seed:** your routing examples.

**Verification:**
- `turbo run lint typecheck test` is green.
- **Providers package:** 28 tests, covering:
  - your routing examples (Merchant A → P1, Merchant B → P2, slabs, fallback when DOWN);
  - tie-breaks, capabilities and time windows;
  - failover never calling a second provider after an ambiguous outcome;
  - real-socket classification of refused connections, timeouts, 4xx/5xx, malformed bodies and invalid endpoints;
  - provider-a request signing;
  - mock determinism and webhook HMAC.
- **API:** 88 integration tests (10 new). They cover the seeded routing, maintenance failover, write-only credentials (never in responses or audit), connection classification, and signed, deduplicated webhooks where forgeries are not stored.
- **Worker:** an integration test of the full breaker cycle (ACTIVE → DOWN → DEGRADED → ACTIVE, with audit and outbox rows) that also confirms manual statuses are untouched.
- **Dev stack:** the worker probes the seeded providers with no spurious status changes.

**Notes:**
- The provider-a and provider-b templates are not connected to real partners and stay DISABLED until a real API spec is mapped.
- Processing of stored inbound provider events arrives with Payin and Payout (Phases 5–6).
- The latency list used for p95 is not trimmed by the last status change. Only the counters are trimmed. This is acceptable for now; revisit in Phase 10.
