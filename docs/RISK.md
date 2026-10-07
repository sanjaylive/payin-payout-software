# Risk engine

Pay2All screens payins and payouts with configurable rules. Every hit is stored with exactly why it fired. Enforced controls stay in place until a person reviews them.

Code: `apps/api/src/modules/risk/`. Validation: `packages/validation/src/risk.ts`. Tests: `apps/api/test/risk.e2e-spec.ts`.

## 1. Concepts

| Table | What it holds |
| --- | --- |
| `risk_rules` | Type, service (PAYIN/PAYOUT), params, action, mode, enabled, priority, version. |
| `risk_events` | One row per rule hit: rule code and version, merchant, subject (payment, payout, merchant, bank account), action, whether enforced, a human reason, machine evidence, review status. |
| `risk_actions` | Merchant-level controls an enforced event applied (settlement hold, disabled service), with what to undo. |

- **Modes:**
  - `MONITOR` (the default) records what the rule *would* have done and changes nothing.
  - `ENFORCE` applies the action.
  - New rules should run in MONITOR until their hit rate is understood.
- **Versioning:** every edit bumps `version`. An edit needs a reason and is audited with old and new values. Events keep the rule version and a snapshot of the params they were evaluated with (`evidence.rule_params`).

## 2. Actions

| Action | Payin (inline) | Payout (inline) | Background sweep |
| --- | --- | --- | --- |
| `ALLOW` | Record only. | Record only. | Record only. |
| `BLOCK` | Declined with `RISK_BLOCKED` (403). | Declined with `RISK_BLOCKED` (403). | Not available. |
| `MANUAL_REVIEW` | The payment proceeds (a customer can't wait for a human); a review case opens. | Payout created in `MANUAL_REVIEW` with `review_kind = RISK`. Funds are reserved and nothing is sent until a reviewer decides. | A review case opens on the merchant. |
| `HOLD_SETTLEMENT` | Places a settlement hold; the transaction proceeds. | Same. | Same. |
| `DISABLE_PAYIN` / `DISABLE_PAYOUT` | Switches the service off. If it is the service being used, this request is declined too. | Same. | Same. |

Rules about who sees what:
- Merchants are never told which rule fired. They see "declined by risk controls" or "held for review".
- A `BLOCK` is a replayable idempotent outcome: retrying with the same key returns the same 403.

Which actions each rule type accepts is enforced by `allowedRiskActions()`. For example, `BLOCK` exists only inline, and a shared-account rule can only record or open a review.

## 3. Rule types

### 3.1 Inline (evaluated while the request is in progress)

| Type | Fires when | Data source |
| --- | --- | --- |
| `VELOCITY` | More than `max_count` transactions from one merchant within `window_seconds`. | Redis sliding window (sorted set per rule and merchant). |
| `AMOUNT_ANOMALY` | Amount ≥ `min_amount` **and** above `multiplier` × the merchant's `lookback_days` average. With fewer than `min_sample` past transactions, it compares against the maximum ticket size declared at onboarding instead. | Count and sum cached in Redis for 10 minutes. |
| `NEW_MERCHANT_VOLUME` | Merchant approved within `new_merchant_days` and today's volume plus this amount exceeds `max_daily_amount`. | `merchant_period_usage` (exact, one primary-key read). |
| `BENEFICIARY_FAN_IN` (payout) | More than `max_count` payouts to the same bank account or UPI ID, from any merchant, within `window_seconds`. | Indexed count on the blind-indexed account hash. |

### 3.2 Background sweep (jobs process, every 5 minutes)

| Type | Fires when | Dedupe window |
| --- | --- | --- |
| `VOLUME_SPIKE` | Last-24h volume ≥ `min_amount` and above `multiplier` × the daily average of the previous `baseline_days`. | IST day |
| `FAILED_ATTEMPTS` | At least `min_failed` failures and a `failure_rate_percent`% failure rate within `window_minutes`. | Window bucket |
| `SHARED_BANK_ACCOUNT` (payout) | One bank account paid by at least `min_merchants` merchants within `lookback_days`. | IST day |

How the sweep behaves:
- Hits are deduplicated per rule version, subject and window, so re-running a sweep never raises the same alarm twice. Editing a rule (a new version) evaluates afresh.
- Each rule produces at most 200 hits per sweep.

All thresholds are integers or rupee strings, never floats. The integer arithmetic used is in `risk-evaluators.ts`, which has unit tests.

## 4. Where the inline checks run

- **Payins:** after merchant-state and per-transaction limit checks, before routing. Events are written in the same transaction that creates the payment.
- **Payouts:** after beneficiary checks, before routing. Events and controls are written in the reservation transaction, before the merchant balance lock is taken, so the critical section doesn't grow.
- **Blocked requests:** the event is written on its own, then the request is declined.

**Failure policy:** if a rule cannot be evaluated (Redis or DB error), it is **skipped**. This is counted in `risk_evaluation_errors_total` and has an alert (`RiskEvaluationErrors`). Risk sits on top of KYC, limits and maker-checker; failing closed would turn a Redis blip into a full payment outage. This is a deliberate trade-off.

## 5. Manual review

`OPEN` events are listed under Admin → Risk → Manual Reviews. These are enforced reviews, holds and disabled services. Reviewers need `risk.review` (COMPLIANCE, OPERATIONS, ADMIN) and must write a note. Both decisions are audited.

- **Clear (false positive):**
  - lifts this event's controls;
  - moves a held payout on to approvals (if its tier needs them) or to the send queue, once no other open event still holds it.
- **Confirm (genuine):**
  - keeps the controls;
  - rejects a held payout (`RISK_DECLINED`) and releases its reservation through the normal `PAYOUT_RELEASE` journal;
  - other open events on that payout close with it.

**Stacked controls:** several events can apply the same control to one merchant. A control is only removed when the *last* of them is lifted. The "was it on before?" fact (`previous_value`) and the hold ownership move to a surviving action, so lifting never switches on a service a human had switched off.

**Unknown-outcome payouts** (`review_kind = UNKNOWN_OUTCOME`, Phase 6) are a separate queue. A risk-held payout can never be resolved through that path as SUCCESS, which would post a settlement for money that never left. This is enforced in the service and in `applyOutcome`, and covered by tests.

## 6. Permissions

| Permission | Holders | Allows |
| --- | --- | --- |
| `risk.read` | COMPLIANCE, OPERATIONS, ADMIN, SUPER_ADMIN | Rules, events, active controls. |
| `risk.manage` | COMPLIANCE, ADMIN, SUPER_ADMIN | Create and edit rules. |
| `risk.review` | COMPLIANCE, OPERATIONS, ADMIN, SUPER_ADMIN | Resolve events, lift controls. |

All risk endpoints are platform-only. Merchants, resellers and API keys get 403.

## 7. Starter rules

`packages/database/prisma/seed-risk.ts` creates twelve starter rules, all in **MONITOR** mode. The development seed applies them. A production environment should create them once (same file, or through the API) and switch individual rules to ENFORCE after reviewing a few weeks of `risk_events`.

## 8. Known limits

- The background sweeps aggregate the last 24 hours (`VOLUME_SPIKE`) or the window (`FAILED_ATTEMPTS`) with indexed range scans. That is fine up to a few million transactions a day. At sustained platform-wide volumes near 1000 TPS, replace them with hourly rollups (docs/perf/INDEX_REVIEW.md §5).
- Rules apply platform-wide. Per-merchant or per-risk-category scoping is a natural next step (add a nullable `risk_category` / `merchant_id` filter to `risk_rules`).
- The rule cache is per process with a 15s TTL, so an edit reaches every API node within 15s.
