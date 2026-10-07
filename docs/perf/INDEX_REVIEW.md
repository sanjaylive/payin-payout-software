# Index review and partitioning readiness (Phase 10)

This review covers every recurring query: queue claims, pollers, sweepers, list pages, limit checks and risk lookups. It checked them against the existing indexes and used `EXPLAIN (ANALYZE, BUFFERS)` on the load-test database (93k payments, 27k payouts). `pg_stat_statements` (enabled in the dev Postgres via docker-compose) ranked the statements by total time under load.

Changes ship in migrations `…_risk_reports_observability`, `…_index_review` and `…_period_usage`.

## 1. Already sound (no change)

| Path | Index |
| --- | --- |
| Merchant / reseller / platform lists (keyset) | `(merchant_id, created_at DESC, id DESC)`, `(reseller_id, created_at DESC)`, `(created_at DESC, id DESC)`; index-only scan, 0.19 ms for a page |
| Payin poller / expiry | partial `payments_open_poll`, `payments_open_expiry` (status IN CREATED, PENDING) |
| Payout processor / poller | partial `payouts_due` |
| Outbox relay | partial `outbox_events_unpublished (occurred_at, id) WHERE published_at IS NULL`; index-only scan |
| Webhook / notification queues | partial `webhook_deliveries_due`, `notifications_due` |
| Settlement selection | partial `payments_unsettled (merchant_id, success_at)` |
| UTR / RRN / provider references | partial unique / lookup indexes |
| Idempotency, processed events, API log retention | `(expires_at)`, `(processed_at)`, `(created_at)` |

## 2. Added

| Index | Why |
| --- | --- |
| `payments_commission_due`, `payouts_commission_due` (partial: reseller, captured or settled, not yet accrued) | The Phase 9 commission sweeper ran `NOT EXISTS (ledger_journals …)` against **every reseller transaction ever captured**, once a minute: O(history). It now uses a `commission_accrued_at` marker set in the accrual transaction. The partial index holds only the backlog, so the sweep is O(backlog). Existing accruals were backfilled. |
| `payouts (beneficiary_id, created_at)` (replaces `(beneficiary_id)`) | Risk fan-in counts payouts to an account within a time window. |
| `beneficiaries (lower(upi_id))` (partial) | Fan-in by UPI ID across merchants; the existing unique index is per merchant. |
| `payouts (reseller_id, created_at DESC)`, `payouts (created_at DESC, id DESC)` | Reseller and platform payout lists matched what payments already had. |
| `settlements (reseller_id, created_at DESC)` (partial) | Reseller settlement lists. |
| `risk_events` (status, merchant, rule, subject, time), `risk_actions` (merchant + active), `report_exports` (org, status) | New tables, indexed for their list and claim queries. |

## 3. Replaced: period limits from running totals

**Finding (load test run 3):** 79% of all database time went to the payin daily/monthly limit check. It is `SUM(amount), COUNT(*)` over the merchant's payments since the start of the IST day **and** month, run twice per payin. Mean time was 8.8 ms and rising with the merchant's volume; payouts added another 7%. At production volumes this alone would cap the platform.

**Change:** a new table, `merchant_period_usage (merchant_id, service, period)` with periods like `D2026-10-07` / `M2026-10`:
- **Create:** the payin or payout create transaction runs one `INSERT … ON CONFLICT DO UPDATE … WHERE usage + amount <= limit RETURNING`. The check and the increment are a single atomic statement, so concurrent requests can never jointly overshoot a limit.
  - Payins run it as the last statement before commit, so the row lock is held only briefly.
  - Payouts run it inside the existing merchant balance lock.
- **Failure:** the status-transition code (the only writer of status) decrements the row when a transaction moves to a non-counted status (payin FAILED/EXPIRED/CANCELLED; payout FAILED/REJECTED).
- **Late success:** a payin that succeeds after being failed is counted again.
- **Keys:** rows are keyed by the transaction's own `createdAt`, set from the same clock as the check, so a release always hits the rows that were incremented.
- **Backfill:** the migration backfilled the last 62 days with the same status filters the old query used.

Results:
- **Load:** database CPU fell ~36% at a higher request rate (RESULTS §runs 3→4).
- **Correctness:** after the load test the counters matched the transactions exactly.
- **Tests:** `limits-usage.e2e-spec.ts` checks that exactly 10 of 20 concurrent ₹100 payins pass a ₹1,000 daily limit, that count limits apply, that failure releases usage, that late success re-counts it, and that payout rejection releases it. Removing the `WHERE` condition fails 3 of the 4 tests.

The risk engine's new-merchant volume check reads the same table: one primary-key read instead of a `SUM()`.

## 4. Known heavier queries (acceptable now, documented)

- **Risk sweeps** (`VOLUME_SPIKE`, `FAILED_ATTEMPTS`) aggregate the last 24 hours or the window every 5 minutes over the `created_at` index. That is fine up to a few million rows a day; beyond that, see §5.
- **Ledger balance verification** (worker, hourly) sums entries per account. It is O(entries) and belongs on a read replica at scale.
- **Payment stats** (dashboard charts) aggregate over the requested range. They are bounded by the UI's maximum range.

## 5. Partitioning readiness

Tables that grow without bound: `payments`, `payouts`, `ledger_entries`, `ledger_journals`, `outbox_events`, `webhook_events`/`webhook_deliveries`, `api_request_logs`, `audit_logs`, `risk_events`.

**Already prepared:**
- Every hot query is time-bounded or keyed by a partial index.
- Primary keys are time-ordered ULIDs; `created_at` is on every table.
- Retention jobs already delete by `created_at` for request logs (90 days), processed events and idempotency records.

**When volume requires it** (rule of thumb: a table beyond ~200 M rows, or vacuum unable to keep up), partition by month on `created_at` (`posted_at` for journals):
1. Postgres requires the partition key in every unique constraint. Add `created_at` to the primary key, or keep a separate non-partitioned `id → created_at` lookup for the few by-id paths that lack a time hint.
2. Partition-local copies of today's partial indexes keep queue claims small.
3. Replace the risk sweeps with an hourly rollup table (`merchant_hourly_volume`) fed by the same transactions that maintain `merchant_period_usage`. That turns `VOLUME_SPIKE` and `FAILED_ATTEMPTS` into reads of at most 24 × 14 rows per merchant.
4. For `api_request_logs` / `audit_logs` / `outbox_events`, monthly partitions make retention a `DROP PARTITION` instead of a large `DELETE`. Audit logs stay append-only: retention moves old partitions to archive storage.
5. `ledger_entries` must never be updated or deleted. Old partitions can move to cheaper tablespaces; balances do not depend on them because maintained balances and snapshots exist.

**Not done now:** introducing partitioning before the volume exists adds operational risk (migration of foreign keys, unique constraints), with no benefit at current sizes.
