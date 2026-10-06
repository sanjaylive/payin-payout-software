# Payout (Disbursement) Flow

> Status: implemented in Phase 6 (see §13 for refinements); Kafka-driven processing arrives in Phase 7. Related: [ARCHITECTURE.md](./ARCHITECTURE.md), [DATABASE.md](./DATABASE.md), [LEDGER.md](./LEDGER.md), [PAYIN_FLOW.md](./PAYIN_FLOW.md)

A payout moves money **out** of a merchant's available balance to a beneficiary through a partner bank or PSP. It is the highest-risk flow on the platform. Every design choice here prefers "stuck and visible" over "duplicated or lost".

## 1. Payout types and modes

| `purpose` | Typical source | Notes |
| --- | --- | --- |
| `CUSTOMER_PAYOUT` | API | Winnings, cashback, withdrawals |
| `VENDOR_PAYMENT` | API / dashboard | B2B |
| `REFUND_PAYOUT` | API / dashboard | Refund to a bank account outside the payin rail |
| `SALARY` | Bulk | Usually maker-checker |
| `API_PAYOUT` | API | Generic |
| Bulk | CSV upload | Each row becomes a normal payout (see §9) |

| Mode | Constraints (defaults, configurable per provider/merchant) |
| --- | --- |
| `IMPS` | 24×7. Per-transaction max from config (default ₹5,00,000). Instant. |
| `NEFT` | 24×7 batch. No hard minimum. Slower finality (pending is common). |
| `RTGS` | **Minimum ₹2,00,000**. Banking-hours availability per provider. |
| `UPI` | Requires `upi_id`. Per-transaction max from config (default ₹1,00,000). |

The routing engine (ARCHITECTURE.md §9) picks the provider from mode, amount, merchant and health. A mode that no healthy route supports returns `PROVIDER_UNAVAILABLE` **before** any reservation is made.

## 2. Amount format

> **Decided (Phase 5, option a):** external `amount` is a **string decimal in major units, with at most 2 decimals** (`"15000.00"`), parsed exactly into paise. JSON numbers are rejected. Internally everything is `BIGINT` paise.

## 3. Beneficiaries

| Field | Storage |
| --- | --- |
| `beneficiaryId` | `ben_<ulid>` |
| `merchantId` | tenant owner, from credentials |
| `name`, `type` (`INDIVIDUAL`/`BUSINESS`) | plain |
| account number | `accountNumberEncrypted` (AES-256-GCM, key ID) + `accountNumberMasked` (`XXXXXX7890`) + `accountNumberHash` (HMAC-SHA256 with a dedicated key, for duplicate and risk lookups without decrypting) |
| `ifsc`, `bankName` | IFSC validated by format and resolved against a bank master |
| `upiId`, `mobile`, `email` | plain (mobile and email masked in logs) |
| `verificationStatus` | `PENDING`, `VERIFIED`, `FAILED`, `BLOCKED` |
| `verificationReference`, `verifiedName`, `nameMatchScore` | from penny-drop / VPA validation |

- **Verification:** `PayoutProvider.verifyBeneficiary()` performs a penny-drop (₹1 credit and bank-returned name) or a VPA lookup. The returned name is compared with the stored name (normalised, token-based similarity). If the score is below the threshold, the beneficiary is `FAILED`, or flagged for manual review when the merchant config allows. The penny-drop cost is a priced, ledgered transaction.
- Policy per merchant: `payout.require_verified_beneficiary` (default true for API payouts above a configurable amount).
- `BLOCKED` is set by risk or ops (e.g. one account hash used by many merchants). Blocked beneficiaries cannot receive payouts.
- Full account numbers are **never** returned by the API, written to logs, or put into webhook payloads. Decryption happens only inside the worker when calling the provider.
- Inline beneficiaries (sent in the payout request) are upserted by `(merchantId, accountNumberHash, ifsc)`, so repeated payouts reuse one beneficiary record.

## 4. API

Auth: API key + HMAC (public API) or a dashboard session with `payout.create`. The merchant is always resolved from credentials.

### 4.1 `POST /v1/payouts`

Headers: `Idempotency-Key` (required).

```json
{
  "merchant_order_id": "PAYOUT001",
  "amount": "15000.00",
  "currency": "INR",
  "mode": "IMPS",
  "beneficiary": {
    "name": "ABC Vendor",
    "account_number": "50100123457890",
    "ifsc": "HDFC0001234"
  },
  "purpose": "VENDOR_PAYMENT",
  "narration": "Invoice 4412",
  "metadata": { "invoice": "4412" }
}
```

`beneficiary` may instead be `{ "beneficiary_id": "ben_01JA…" }`.

`202 Accepted`:

```json
{
  "success": true,
  "data": {
    "payout_id": "pout_01JA9C2D4F6G8H0J2K4M6N8P0Q",
    "merchant_order_id": "PAYOUT001",
    "amount": "15000.00",
    "fee": "5.00",
    "tax": "0.90",
    "total_debit": "15005.90",
    "currency": "INR",
    "mode": "IMPS",
    "status": "APPROVAL_PENDING",
    "approvals_required": 1,
    "beneficiary": { "beneficiary_id": "ben_…", "name": "ABC Vendor", "account_number_masked": "XXXXXXXXXX7890", "ifsc": "HDFC0001234" },
    "created_at": "2026-10-06T10:00:00.000Z"
  },
  "meta": {}
}
```

It returns `202` because completion is asynchronous. The final status arrives by webhook or `GET`.

### 4.2 `GET /v1/payouts/:payoutId` and `GET /v1/payouts`

- `GET /v1/payouts/:payoutId` adds `utr`, `failure_code`, `failure_reason`, `processed_at`, `reversed_at`, and the `approvals[]` trail.
- `GET /v1/payouts` uses the same filter and pagination contract as payins: `status`, `mode`, `purpose`, `merchant_order_id`, `payout_id`, `utr`, `beneficiary_id`, `amount_min`/`amount_max`, date range, keyset `cursor`, and `limit ≤ 100`.

### 4.3 Dashboard-only

- `POST /v1/payouts/:id/approve` and `/reject` (`payout.approve`, MFA-verified session required)
- `POST /v1/payouts/bulk` (CSV upload) and `GET /v1/payouts/bulk/:batchId`
- `POST /v1/beneficiaries`, `GET /v1/beneficiaries`, `POST /v1/beneficiaries/:id/verify`

### 4.4 Error codes

`INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `MERCHANT_INACTIVE`, `KYC_NOT_APPROVED`, `PAYOUT_DISABLED`, `INSUFFICIENT_BALANCE` (422), `DUPLICATE_ORDER` (409), `IDEMPOTENCY_CONFLICT` (409), `LIMIT_EXCEEDED` (422), `RISK_BLOCKED` (422), `BENEFICIARY_NOT_VERIFIED` (422), `BENEFICIARY_BLOCKED` (422), `PROVIDER_UNAVAILABLE` (503), `TRANSACTION_NOT_FOUND` (404), `INVALID_STATE_TRANSITION` (409, approve/reject on a non-pending payout), `SELF_APPROVAL_NOT_ALLOWED` (403).

## 5. The recommended flow, mapped to implementation

| # | Requirement step | Implementation |
| --- | --- | --- |
| 1 | Validate merchant | `MerchantGuardService.assertActive(merchantId)`: status `APPROVED` and not suspended (cached 30 s and invalidated on a status change) → `MERCHANT_INACTIVE` |
| 2 | Validate KYC | Same service: KYC approved → `KYC_NOT_APPROVED`. `payoutEnabled` → `PAYOUT_DISABLED` |
| 3 | Validate limits | `LimitService.check(PAYOUT, merchant, amount)`: per-txn min/max, mode constraints (§1), and daily/monthly amount and count. Counters are Redis-assisted and DB-authoritative, and they are **re-checked inside the transaction** against committed payouts for the day bucket. |
| 4 | Risk check | `RiskService.evaluateSync()`: velocity, many payouts to the same beneficiary hash, new merchant with a high amount. `BLOCK` → `RISK_BLOCKED`. `MANUAL_REVIEW` → payout created in `MANUAL_REVIEW`. |
| 5 | Verify idempotency | `IdempotencyRecord` insert as `IN_PROGRESS` (same mechanics as PAYIN_FLOW.md §4), with unique `(merchantId, merchantOrderId)` as a backstop |
| 6 | Begin DB transaction | `prisma.$transaction(…, { isolationLevel: ReadCommitted, timeout: 5s })` with explicit row locks (below) |
| 7 | Lock / reserve balance | `SELECT … FROM ledger_accounts WHERE id = $merchantAvailable FOR UPDATE`. Check `balance_minor ≥ amount + fee + tax`, else `INSUFFICIENT_BALANCE` (rollback, idempotency record stored as COMPLETED 422). Then post `PAYOUT_RESERVE` (AVAILABLE → RESERVED, idempotency key `payout:pout_X:reserve`). |
| 8 | Create payout | Insert `Payout` with status `QUEUED` (no approval needed), `APPROVAL_PENDING` (maker-checker), or `MANUAL_REVIEW` (risk). Also insert the pricing snapshot and the masked beneficiary snapshot. |
| 9 | Create outbox event | `payout.created` (always) + `payout.process` (only when `QUEUED`) |
| 10 | Commit | The idempotency record is updated to COMPLETED with the 202 body in the same transaction |
| 11 | Worker processes provider payout | The `payout.process` consumer (§7) |
| 12 | Update transaction from provider response | Conditional state transitions (§8) |
| 13 | Post/release ledger | Success → `PAYOUT_SETTLE` (RESERVED → provider clearing, fee → revenue, GST → tax payable). Failure, reject or reversal → `PAYOUT_RELEASE` / `REVERSAL` (RESERVED → AVAILABLE). Recipes in LEDGER.md. |

Steps 1–5 run **before** the transaction (cheap, no locks held). Step 3's amount checks are repeated under the lock in step 7, because limits are financial invariants too.

### Balance reservation details

- **Reserve at creation, not at approval.** Funds awaiting approval are held, so an approved payout can never fail with insufficient balance later, and the merchant sees an accurate available balance.
- Lock scope: only the merchant's `AVAILABLE` account row. Concurrency is therefore per merchant, and different merchants never contend.
- The DB `CHECK (balance_minor >= 0)` on non-negative accounts is the last line of defence. A violation becomes `INSUFFICIENT_BALANCE`, never a 500.
- The reservation is released on reject, approval timeout (configurable, default 72 h), definitive failure, or cancellation. It is consumed on success.

## 6. Maker-checker approvals

Default tiers (configurable at **SYSTEM → RESELLER → MERCHANT**, most specific wins, stored in `ApprovalPolicy`):

| Amount | Approvals |
| --- | --- |
| ₹0 – ₹10,000 | `AUTO` (0) |
| ₹10,000.01 – ₹1,00,000 | `ONE_APPROVER` (1) |
| above ₹1,00,000 | `TWO_APPROVERS` (2) |

The resolved tier is frozen on the payout (`approvalsRequired`) at creation. Later policy edits do not affect in-flight payouts.

Rules:

- An approver needs `payout.approve` in the payout's merchant org, and an MFA-verified session.
- **The maker cannot approve their own payout** (`createdById ≠ approverId` → `SELF_APPROVAL_NOT_ALLOWED`). The same approver cannot count twice, enforced by the unique `(payoutId, approverId)` constraint on `PayoutApproval`.
- API-created payouts (no human maker) still go through approval when the tier requires it. Here the maker is the API key, and every human approver qualifies.

Race-safe approval transaction:

```sql
INSERT INTO payout_approvals (id, payout_id, approver_id, decision) VALUES (…);   -- unique blocks double vote
UPDATE payouts
   SET approvals_received = approvals_received + 1, version = version + 1,
       status = CASE WHEN approvals_received + 1 >= approvals_required THEN 'QUEUED' ELSE status END
 WHERE id = $1 AND status = 'APPROVAL_PENDING'
RETURNING status;
```

When the returned status is `QUEUED`, the same transaction inserts outbox `payout.process`. Two approvers racing on the last approval serialize on the row update, so exactly one transition to `QUEUED` happens and exactly one `payout.process` event is emitted. A rejection transitions `APPROVAL_PENDING → REJECTED` and posts `PAYOUT_RELEASE` in the same transaction. All approvals and rejections are audited.

## 7. Worker processing (`payout.process` consumer)

```
consume payout.process(pout_X)
 ├─ txn A: INSERT processed_events(consumer, event_id)              -- duplicate event → skip
 │         UPDATE payouts SET status='PROCESSING' WHERE id=$1 AND status='QUEUED' AND version=$v
 │         INSERT payout_attempts(payout_id, attempt_no=1, provider_id, provider_idempotency_ref='pout_X-1', status='INITIATED')
 │  COMMIT                                                          -- 0 rows updated → someone else owns it → stop
 ├─ decrypt beneficiary account (in memory only)
 ├─ provider.createPayout({ reference: 'pout_X-1', … })             -- timeout 15 s
 └─ txn B: record attempt result + transition (see §8) + ledger + outbox payout.updated / webhook event
```

- **One attempt reference per attempt.** `provider_idempotency_ref` is sent as the provider's client reference, and most banks reject a duplicate reference. A new attempt (new reference) is created **only** after the previous attempt is *definitively* failed, never after a timeout.
- **Crash safety.** `PROCESSING` with an `INITIATED` attempt and no response means the outcome is unknown. Recovery never re-sends blindly. It calls `getPayoutStatus(reference)` first.

| Crash point | State left behind | Recovery |
| --- | --- | --- |
| Before txn A commits | `QUEUED`, no attempt | Kafka redelivers (offset not committed) and processing starts cleanly |
| After txn A, before provider call | `PROCESSING`, attempt `INITIATED` | The stuck-payout sweeper (attempts older than 2 min) calls `getPayoutStatus('pout_X-1')`. NOT_FOUND from a provider that guarantees reference lookup means the request was never received, so it is safe to send with the **same** reference. Otherwise the status is applied. |
| During provider call | `PROCESSING`, unknown at provider | Same as above. The provider dedupes on the reference even if the call is re-sent with it. |
| After provider response, before txn B | Provider knows the result, we don't | The sweeper's status query gets the result, and txn B runs from the sweeper |
| After txn B, before Kafka offset commit | Fully recorded | Redelivery hits `processed_events` / the conditional update and becomes a no-op |
| Outbox relay crash | Events unpublished | The relay resumes from `published_at IS NULL`. Consumers dedupe. |

Providers that **cannot** look up by our reference are flagged `supportsReferenceLookup = false`. For them, an unknown outcome goes to `MANUAL_REVIEW` and is never auto re-sent.

## 8. Provider response handling

| Provider outcome | Payout transition | Ledger | Event |
| --- | --- | --- | --- |
| Accepted, final SUCCESS (with UTR) | `PROCESSING → SUCCESS` | `PAYOUT_SETTLE` | `payout.success` |
| Accepted, in progress | `PROCESSING → PENDING` | none (stays reserved) | `payout.processing` |
| Definitive failure (invalid account, beneficiary bank rejected) | `PROCESSING/PENDING → FAILED` | `PAYOUT_RELEASE` | `payout.failed` |
| Pre-acceptance failure (connection refused before send, explicit "not accepted") | attempt `FAILED`, then the router may pick a **fallback** provider: new attempt with a new reference, payout stays `PROCESSING` | none | — |
| Timeout / 5xx / unparseable | attempt `UNKNOWN`, payout stays `PROCESSING`, then status poll | none | — |
| Unknown after the polling window (default 24 h) | `→ MANUAL_REVIEW` | none (funds stay reserved) | ops alert |

Fallback runs only on **pre-acceptance** failures, as classified by each adapter's error mapper. When in doubt, the mapper returns `UNKNOWN`, never `FAILED`.

**Status polling:** `PENDING`/`PROCESSING` payouts are polled with backoff (30 s, 1 m, 2 m, 5 m, 15 m, then hourly). Provider status webhooks, where available, go through the same transition service.

**Reconciliation:** daily provider and bank statements are matched on reference and UTR. `STATUS_MISMATCH` (ours FAILED, bank debited) becomes a critical alert, resolved manually with journals.

### Reversal after success (bank return)

A beneficiary bank can return funds days later (closed account, etc.).

- `SUCCESS → REVERSED` happens via provider callback or recon. It posts a `REVERSAL` journal that credits the merchant AVAILABLE with the principal. Whether the fee is refunded is merchant pricing configuration, captured in the snapshot.
- The original `PAYOUT_SETTLE` journal is never edited. The reversal links to it through `reversesJournalId`. Event: `payout.reversed`.

## 9. Bulk payouts

1. Upload a CSV (`POST /v1/payouts/bulk`). The file goes to S3, and a `BulkPayoutBatch(UPLOADED)` record is created, with the file hash used to dedupe an identical re-upload.
2. The worker validates rows asynchronously (schema, IFSC, mode constraints, duplicate `merchant_order_id` inside the file and against the DB) and produces a validation report. The batch becomes `VALIDATED` or `VALIDATION_FAILED`.
3. The user confirms (maker). Approval tiers apply to the **batch total** and to each row's amount, whichever is stricter. MFA is required.
4. The worker creates payouts row by row through the **same** creation service, with idempotency key `bulk:<batchId>:<rowNo>` and the row's `merchant_order_id`. Re-running a half-processed batch is therefore safe. Each row reserves balance independently. Rows that hit `INSUFFICIENT_BALANCE` are marked failed, and processing continues or stops per the batch setting `stop_on_insufficient_balance`.
5. Batch progress counters are shown in the dashboard. Each payout follows the normal lifecycle.

## 10. Payout state machine

```
CREATED ─► VALIDATING ─┬─► APPROVAL_PENDING ─┬─► QUEUED ─► PROCESSING ─┬─► SUCCESS ─► REVERSED
                       │                     └─► REJECTED              ├─► PENDING ─┬─► SUCCESS
                       ├─► QUEUED                                     │            └─► FAILED
                       ├─► MANUAL_REVIEW ─► QUEUED | REJECTED          ├─► FAILED
                       └─► FAILED                                     └─► MANUAL_REVIEW ─► SUCCESS | FAILED
```

| From | Allowed to |
| --- | --- |
| `CREATED` | `VALIDATING`, `FAILED` |
| `VALIDATING` | `APPROVAL_PENDING`, `QUEUED`, `MANUAL_REVIEW`, `FAILED` |
| `APPROVAL_PENDING` | `QUEUED`, `REJECTED` |
| `MANUAL_REVIEW` (pre-send, risk) | `QUEUED`, `REJECTED` |
| `QUEUED` | `PROCESSING`, `REJECTED` (cancel before pickup) |
| `PROCESSING` | `PENDING`, `SUCCESS`, `FAILED`, `MANUAL_REVIEW`, `QUEUED` (requeue only when every attempt provably never reached a provider) |
| `PENDING` | `SUCCESS`, `FAILED`, `MANUAL_REVIEW` |
| `MANUAL_REVIEW` (post-send, unknown outcome) | `SUCCESS`, `FAILED` (only with provider/bank evidence and an audit reason) |
| `SUCCESS` | `REVERSED` |
| `FAILED`, `REJECTED`, `REVERSED` | — (terminal) |

`CREATED` and `VALIDATING` are usually transient inside the creation transaction. They are persisted for bulk rows and for async beneficiary verification. Every transition uses the conditional update `WHERE status = ANY($from) AND version = $v`. `SUCCESS → PENDING`, `FAILED → SUCCESS` without manual evidence, and any move out of a terminal state are rejected.

## 11. Failure modes

| Scenario | Behaviour |
| --- | --- |
| Same request retried (same key) | The stored response is replayed. One payout, one reservation. |
| Same order, new key | `DUPLICATE_ORDER` via unique `(merchantId, merchantOrderId)` |
| Two concurrent payouts draining the same balance | Serialized on the AVAILABLE row lock. The second sees the reduced balance and gets `INSUFFICIENT_BALANCE`. |
| `payout.process` delivered twice | `processed_events` + conditional `QUEUED → PROCESSING` → second is a no-op |
| Provider timeout | `UNKNOWN` → poll by reference, never re-send with a new reference |
| Provider down before accept | Fallback provider (new attempt) or stays `QUEUED` and retries after the circuit closes |
| Provider says SUCCESS, later bank return | `REVERSED` + `REVERSAL` journal |
| Approver approves own payout | `SELF_APPROVAL_NOT_ALLOWED` |
| Two approvers race on final approval | Exactly one `QUEUED` transition and one process event |
| Merchant suspended while payout is queued | Worker re-checks `payoutEnabled` before the provider call. If disabled: `QUEUED → REJECTED` + release (or held per risk action). |
| Approval never given | Approval timeout job: `APPROVAL_PENDING → REJECTED` (reason `APPROVAL_EXPIRED`) + `PAYOUT_RELEASE` |
| DB check constraint fires (balance < 0) | Transaction rolls back → `INSUFFICIENT_BALANCE`. Invariant alert if it fires outside the reservation path. |

## 12. Required tests (Phase 6 exit criteria)

| Test | Assertion |
| --- | --- |
| Concurrent payout | 50 parallel payouts, each 10 % of the balance → exactly 10 succeed in reserving, 40 get `INSUFFICIENT_BALANCE`, final AVAILABLE = 0, every journal balanced |
| Insufficient balance | Balance below amount + fee + tax → 422, no payout row, no journal, idempotency record replays the 422 |
| Duplicate payout | Same key ×20 in parallel → 1 payout, 1 reserve journal. Same order with a different key → `DUPLICATE_ORDER`. Same key with a different body → `IDEMPOTENCY_CONFLICT`. |
| Provider failure | Definitive failure → FAILED + RELEASE, balance restored exactly. Timeout → stays PROCESSING, no second provider call with a new reference. |
| Payout reversal | SUCCESS → REVERSED posts a REVERSAL linked to the settle journal, and the merchant balance is restored |
| Maker-checker | Self-approval rejected, double vote rejected, tier frozen at creation, racing final approvals emit one process event |
| Worker crash simulation | Kill between txn A and the provider call → the sweeper resolves via status lookup with no duplicate transfer |
| State machine | Every disallowed transition in §10 is rejected by the transition service |
| Ledger invariant | After every test: Σ debits = Σ credits per journal and globally, and no non-negative account below zero |

## 13. Phase 6 implementation notes

Where the shipped code refines or defers parts of the design above:

- **Processing runs in the API jobs process** (`pnpm dev:jobs`), not a Kafka consumer. `payout.process` is replaced by polling `QUEUED` rows with `FOR UPDATE SKIP LOCKED` every 5 s. Txn A is the claim (`QUEUED → PROCESSING`). Before every provider call, an `INITIATED` attempt with reference `pout_X-n` is committed. Phase 7 swaps the trigger for the outbox/Kafka path; the crash-safety rules stay the same.
- **Requeue.** If every attempt failed with `NOT_ATTEMPTED`/`CONFIGURATION` (provably not sent), the payout goes `PROCESSING → QUEUED` with backoff. This edge was added to §10's table. After 10 requeues it fails and releases (`PROVIDER_UNAVAILABLE`). A definitive `REJECTED` on every candidate fails and releases immediately.
- **Unknown outcomes.** The sweeper (every 15 s, per-payout backoff 30 s → 1 h) looks the latest attempt up by provider reference, else by our reference. A `NOT_FOUND` triggers a same-reference re-send **only** for providers that declare `capabilities.supports_reference_lookup = true`. Otherwise the payout waits, and after 24 h it moves to `MANUAL_REVIEW` with funds still reserved. Platform users with `payout.review` resolve it with evidence: a UTR is required to mark success, and a reason is always required and audited.
- **Critical section.** Payout creation does all lock-free work first: insert, pricing snapshot, idempotency attach. It then locks the merchant `AVAILABLE` row, checks daily/monthly limits (exact under the lock), posts `PAYOUT_RESERVE` and moves the status. Nothing inside the lock takes a second pool connection. If contention persists after the bounded retries, the API returns a retryable `503 SERVICE_UNAVAILABLE`. This releases the idempotency key, so the client can retry with the same key. The 50-way concurrency test produces exactly 10 reservations, 40 `INSUFFICIENT_BALANCE` and 0 errors.
- **Approvals.** Approvers must be in the payout's merchant org, hold `payout.approve`, and have an MFA-verified session (`MFA_ENROLLMENT_REQUIRED` otherwise). The maker cannot approve their own payout but may cancel it (`reject`, code `CANCELLED_BY_MAKER`). Votes are append-only (DB trigger). Without any approval policy, every payout needs one approver (fail-safe). The seed installs the §6 tiers at SYSTEM level.
- **Beneficiaries.** The account number is encrypted with `beneficiary:<merchantId>` as associated data (a ciphertext cannot be replayed under another merchant), masked, and blind-indexed (`beneficiary-account`). Payouts above **₹25,000** need a `VERIFIED` beneficiary. Verification uses the primary payout provider's `verifyBeneficiary` plus a token-based name match (threshold 70). Penny-drop charges are **not** yet priced or ledgered (Phase 8, with provider statements). Unblocking is not exposed yet.
- **Bank return:** `PAYOUT_REVERSAL` (not the generic `REVERSAL` mirror) returns the principal to AVAILABLE and keeps the fee unless the pricing snapshot says `refund_fee`. The settle journal id is recorded in the reversal's metadata.
- **Status mismatches** (we hold `FAILED` and the provider says `SUCCESS`, or vice versa) are never auto-corrected. They are flagged on the payout with a CRITICAL audit entry for reconciliation (Phase 8).
- **Bulk:** CSVs (≤ 1,000 rows, ≤ 1 MB) are validated synchronously at upload and **never stored**. Account numbers go straight into encrypted beneficiaries, so beneficiaries are created even if the batch is later discarded. A batch with any invalid row is `VALIDATION_FAILED`, and the corrected file must be uploaded again. Confirming needs an MFA session. The confirmer becomes the maker of every row. Each row's tier is the stricter of the row amount and the batch total. Rows are created 50 per tick with key `bulk_<batch>_<row>`, and processing stops at the first `INSUFFICIENT_BALANCE`. Checkers can approve or reject every row they may vote on in one action.
- **Risk pre-checks** (velocity, beneficiary fan-out, `MANUAL_REVIEW` before send) arrive in Phase 10. The `MANUAL_REVIEW → QUEUED/REJECTED` transitions already exist for them.
- **Merchant webhooks:** `payout.created/queued/processing/success/failed/rejected/reversed` events are recorded with an outbox row in the same transaction. Delivery is Phase 7.
