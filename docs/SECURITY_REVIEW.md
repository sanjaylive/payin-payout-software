# Security review: Phase 10 (2026-10-07)

This is an end-of-build review of the platform against the OWASP API Security Top 10 (2023) and the project's own rules in SECURITY.md. Each item says what was checked, how, and the result. "Tested" means an automated integration test exists and passes; "Reviewed" means code inspection.

## 1. Findings fixed in this phase

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| F1 | High (availability / scalability) | Daily/monthly limit checks `SUM()`ed the merchant's whole month per request (79% of DB time under load). This is an easy amplification path for a single noisy merchant. | Atomic running totals (perf/INDEX_REVIEW.md §3). Tested, including a concurrency test and a mutation check. |
| F2 | Medium (scalability) | Commission sweeper scanned all reseller transaction history every minute. | Marker column plus a partial index; O(backlog). Tested by the partner suite. |
| F3 | Medium (test integrity) | Integration test files ran **in parallel** although the config said sequential (Vitest 3 ignores pool options inside a project). This hid order-dependent behaviour and made platform-wide fixtures (risk rules) leak between files. | `--no-file-parallelism` on the integration scripts; verified because the summed test time no longer exceeds wall-clock time. 177 API and 13 worker tests pass sequentially. |
| F4 | Medium (dependencies) | `pnpm audit --prod`: 17 advisories. Most were `nodemailer` <10 (the API still declared it although it no longer sends mail; the worker was on 7.x), plus `js-yaml` (via Swagger) and `mysql2` (via the Prisma CLI). | Removed nodemailer from the API, upgraded the worker to nodemailer 10.0.15 (worker suite passes), and added patched same-major overrides for js-yaml and mysql2. **1 remains** (§3). |
| F5 | Low | A held (risk-review) payout could in principle be "resolved" as SUCCESS through the unknown-outcome review path, which would post a settlement for money never sent. This was introduced by reusing `MANUAL_REVIEW` for risk holds, and caught during design. | `review_kind` distinguishes the two queues; refused in `resolveReview` and `applyOutcome`. Tested (409, no attempts created). |

## 2. OWASP API Top 10

| Risk | Status | Evidence |
| --- | --- | --- |
| API1 Broken object-level authorization | ✅ Tested | Every tenant-facing read is `findFirst({ id, ...scope })`; out of scope → 404 (SECURITY.md §3). Cross-tenant tests in rbac-tenancy, payments, payouts, partners, reports (export of another tenant → 404), risk (merchant → 403). **New:** row-level security as a second net for exports (§11). |
| API2 Broken authentication | ✅ Tested | argon2id; refresh rotation with reuse detection; lockout; MFA (TOTP) for staff and payout checkers. API keys: HMAC with timestamp + single-use nonce, IP allowlist, a per-IP throttle on auth failures (observed live during load tests: 61 bad signatures → the IP was cut off for 60s). |
| API3 Broken object-property authorization | ✅ Reviewed | Strict Zod schemas (`strictObject`) reject unknown fields; tenant ids are never taken from bodies; presenters whitelist output fields. Account numbers are masked; hashes are never returned (the risk presenter truncates bank-account subjects). |
| API4 Unrestricted resource consumption | ✅ Tested / reviewed | Body limit 1 MB; per-key and per-IP rate limits; pagination capped at 100; exports async with a 92-day range, 1 M rows and 3 in progress per org; report generation in bounded batches; risk sweeps capped at 200 hits per rule. |
| API5 Broken function-level authorization | ✅ Tested | Permission guard on every route; API keys only on `@ApiKeyAccess` routes; risk, system settings and platform finance endpoints are platform-only (tested 403 for merchants). |
| API6 Unrestricted access to sensitive business flows | ✅ Tested | Maker-checker payouts with MFA checkers; payout reservation before approval; risk rules (velocity, fan-in, new-merchant volume) with block and review; idempotency on every money-moving POST. |
| API7 SSRF | ✅ Tested (Phase 7) | Webhook delivery resolves and pins the IP, refuses private ranges in production, never follows redirects. |
| API8 Security misconfiguration | ✅ Reviewed | Boot validation refuses placeholder secrets, public Swagger, plain-HTTP webhooks, unencrypted S3 and metrics on the public port in production. Helmet with a strict CSP; CORS allow-list; metrics on an internal port with an optional token; System Settings shows configuration without secrets. |
| API9 Improper inventory management | ✅ Reviewed | OpenAPI generated from the same Zod schemas; one versioned prefix (`/v1`); the public API surface is the explicit `@ApiKeyAccess` set (docs/API.md). |
| API10 Unsafe consumption of APIs | ✅ Reviewed | Provider responses classified (`NOT_ATTEMPTED / REJECTED / AMBIGUOUS`); no failover on ambiguous outcomes; provider webhooks signature-verified before storage; amount mismatches held, not captured. |

## 3. Accepted / open items

| Item | Why accepted | Revisit |
| --- | --- | --- |
| `deepmerge-ts` <8 (high, stack exhaustion on recursive objects) | Only inside the Prisma CLI's config loader (`prisma migrate`/`generate`), merging our own static config; not on any request path. Fixing it means a major-version override of Prisma internals. | When Prisma updates its dependency. |
| Risk rules fail open on evaluation errors | A Redis or DB hiccup must not take all payments down. Compensated by an alert on `risk_evaluation_errors_total` and by KYC, limits and maker-checker, which do fail closed. | Per rule `fail_closed` flag if a partner bank requires it. |
| RLS covers export reads only | The main API relies on application-layer scoping (tested per endpoint). Turning RLS on for every request path would need `SET LOCAL` on every transaction and a non-owner runtime role. | When the production DB role layout is finalised: run the API as a non-owner role and extend policies. |
| `security.*` signals (SECURITY.md §10) | Recorded as audit events; not yet fed into the risk engine as rules. | Next iteration: rules on login anomalies and permission-denied bursts. |
| MFA for merchant OWNER/ADMIN is optional | Product decision (ROADMAP open decision 4). | Before go-live. |

## 4. Checks run

- `pnpm audit --prod`: 1 remaining advisory (above).
- Load tests (perf/RESULTS-2026-10-07.md): after 93k payments and 27k payouts under concurrency, every journal balances, no non-negative account is below zero, every maintained balance equals its entries, and limit counters equal their transactions.
- Mutation checks this phase:
  - removing the atomic limit condition fails 3 tests;
  - removing the RLS reader role still leaves the explicit tenant filter, and vice versa; the RLS-only tests prove the database net on its own.
- Secrets in the repo: credentials for load tests are written to a gitignored, mode-600 file and never printed. `.env` is gitignored. No secrets in commits.
