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

## Phase 1 — Foundation 🟡

- [ ] Turborepo + pnpm workspace, shared tsconfig/ESLint/Prettier
- [ ] Docker Compose: Postgres 17, Redis 7, Kafka (KRaft), SeaweedFS (S3), Mailpit
- [ ] `packages/config`: Zod env validation (fails boot on invalid/placeholder secrets in production)
- [ ] `packages/logger`: pino JSON logs with mandatory redaction
- [ ] `packages/types`: response envelope, `ErrorCode` catalog with HTTP mapping
- [ ] `packages/auth`: argon2id hashing, AES-256-GCM envelope encryption, token helpers, permission catalog, system roles
- [ ] `packages/validation`: shared Zod schemas (auth, users, pagination)
- [ ] `packages/database`: Prisma 7 schema (identity, sessions, MFA, audit, outbox, notifications), migration with append-only triggers, seed
- [ ] API core: request ID + AsyncLocalStorage context, response envelope, global exception filter, helmet, CORS, Swagger at `/docs`, health checks
- [ ] Auth: login (email/mobile), lockout, Redis rate limits, JWT access, rotating refresh with reuse detection, sessions list/revoke, logout-all, password forgot/reset/change, TOTP MFA (setup/enable/verify/disable), mandatory MFA for privileged roles
- [ ] IAM: organizations (scoped), users, memberships, roles, permissions, PermissionGuard, TenantScopeService, privilege-escalation guard
- [ ] Audit: append-only writer inside transactions, query API with keyset pagination
- [ ] Worker app skeleton (graceful shutdown, health) and docs app placeholder
- [ ] Web: Pay2All design tokens (light/dark), shadcn/ui, login, MFA, forgot/reset, merchant and admin shells with full navigation, security settings (sessions, MFA), users, roles, audit logs
- [ ] Tests: hashing/crypto/permissions units, auth and RBAC integration (refresh rotation, reuse detection, lockout, cross-tenant 404, permission 403, audit immutability)

## Phase 2 — Merchant & compliance ⬜

- [ ] Merchant + profile + KYC + directors/UBO + bank accounts (encrypted, masked, hashed)
- [ ] Onboarding wizard (DRAFT → SUBMITTED) with server-side step validation
- [ ] Documents: pre-signed S3 upload, sha256, status workflow, expiry
- [ ] Compliance review workflow: append-only `compliance_reviews`, reviewer/time/reason/notes, MORE_INFORMATION_REQUIRED loop
- [ ] Screening status fields (SANCTIONS / PEP / ADVERSE_REVIEW), provider integration stubbed
- [ ] Limits (SYSTEM → RESELLER → MERCHANT resolution) and approval policies
- [ ] Sales CRM: leads, assignment, follow-ups
- [ ] MFA recovery codes
- [ ] Admin UI: all merchants, pending KYC, suspended, merchant detail with review timeline

## Phase 3 — Ledger ⬜

- [ ] Money helpers (`packages/ledger`): parse/format, fee math, rounding, currency validation
- [ ] Chart of accounts provisioning per merchant and platform
- [ ] `postJournal` with balance validation, idempotency key, locked running balances, `balance_after`
- [ ] DB guards: immutability triggers, deferred balanced-journal constraint trigger, CHECK non-negative
- [ ] Balance service (available, pending, unsettled, reserved, lien)
- [ ] Reversal journals, maker-checker manual adjustments
- [ ] Balance verification job + daily `BalanceSnapshot`
- [ ] Tests: Debit = Credit property tests, concurrent postings, duplicate idempotency key, reversal

## Phase 4 — Providers ⬜

- [ ] `PayinProvider` / `PayoutProvider` interfaces, normalized result types and error taxonomy
- [ ] Provider config + encrypted credentials + admin UI
- [ ] Routing engine (rules, PRIMARY/SECONDARY/FALLBACK, health/limit filtering) with explainable decisions
- [ ] Mock payin and mock payout providers with scriptable outcomes (success/fail/pending/timeout)
- [ ] Provider health: Redis rolling windows, circuit breaker, snapshots

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

_(Appended as phases complete.)_
