# Payin (Collection) Flow

> Status: design (implemented in Phase 5). Related: [ARCHITECTURE.md](./ARCHITECTURE.md), [DATABASE.md](./DATABASE.md), [LEDGER.md](./LEDGER.md), [PAYOUT_FLOW.md](./PAYOUT_FLOW.md)

A payin collects money from a merchant's customer through a partner provider (bank / PSP / authorised PA). Pay2All owns the transaction identity (`pay_…`), state machine, pricing snapshot and ledger postings. Provider identifiers are only stored as references.

## 1. Methods

| Method | Status | Customer experience | Provider output we store |
| --- | --- | --- | --- |
| `UPI_QR` | Phase 5 | Dynamic QR rendered by merchant / hosted page | QR string (`upi://pay?...`), expiry |
| `UPI_INTENT` | Phase 5 | Deep link opens UPI app on mobile | intent URL |
| `PAYMENT_LINK` | Phase 5 | Hosted Pay2All page; customer picks a UPI option | short link URL |
| `VIRTUAL_ACCOUNT` | Future | Customer pushes IMPS/NEFT/RTGS to a VA | VA number + IFSC |
| `IMPS` / `NEFT` / `RTGS` | Future | Bank transfer collections (via VA) | UTR on credit |
| `CARDS` / `NETBANKING` | Future | Redirect / hosted checkout | provider order ref |

The public request field `method` accepts the family `UPI`, with an optional `upi_flow` of `QR` or `INTENT` (default: both are returned when the provider supports it). It also accepts an explicit method value such as `UPI_QR`. The method enum is the internal source of truth, and new methods are added without changing the API shape.

## 2. Amount format

> **Decision pending confirmation from Pay2All.**
> External `amount` is a **string decimal in major units (INR) with at most 2 decimal places**, for example `"1000.00"` or `"1000"`. The API parses it **exactly** into paise (`BIGINT`) with a regex and integer arithmetic, so floating point is never involved. JSON numbers (`1000`) are **rejected** with `INVALID_REQUEST`. This avoids float ambiguity and the "is it rupees or paise?" class of bugs.
>
> **Alternative:** integer paise (`"amount": 100000` = ₹1,000.00), as several other gateways use. This is also unambiguous and float-safe for values below 2^53. If Pay2All picks it, only the parsing and presenting layer changes. Storage is paise either way.

Responses always echo `amount` in the same string format plus `currency`.

## 3. API

All endpoints require API key + timestamp + HMAC signature (see SECURITY.md) or a dashboard session with `payin.*` permissions. The merchant is resolved from credentials. A `merchant_id` in the body is rejected.

### 3.1 `POST /v1/payments`

Headers: `Idempotency-Key` (required, 1–64 chars `[A-Za-z0-9_-]`), `X-Pay2All-Key`, `X-Pay2All-Timestamp`, `X-Pay2All-Signature`.

```json
{
  "merchant_order_id": "ORD123456",
  "amount": "1000.00",
  "currency": "INR",
  "method": "UPI",
  "customer": { "name": "Aman", "mobile": "9876543210", "email": "aman@example.com" },
  "expires_in_seconds": 900,
  "metadata": { "cart_id": "c_991" }
}
```

`201 Created`:

```json
{
  "success": true,
  "data": {
    "payment_id": "pay_01JA8Z6T3W4Q9K2M5N7P8R0S1V",
    "merchant_order_id": "ORD123456",
    "amount": "1000.00",
    "currency": "INR",
    "status": "PENDING",
    "method": "UPI_QR",
    "qr": "upi://pay?pa=pay2all.col@bank&pn=Pay2All&tr=pay_01JA8Z...&am=1000.00&cu=INR",
    "upi_intent": "upi://pay?pa=...",
    "expires_at": "2026-10-06T10:15:00.000Z",
    "created_at": "2026-10-06T10:00:00.000Z"
  },
  "meta": {}
}
```

Validation limits: `metadata` holds at most 20 keys with string values of at most 256 chars. `customer.mobile` is a 10-digit Indian mobile. `expires_in_seconds` is clamped to the 120–86,400 range.

### 3.2 `GET /v1/payments/:paymentId`

Returns the payment (scoped to the caller's tenant, and **404 `TRANSACTION_NOT_FOUND`** for another tenant's ID). It includes `utr`, `rrn`, `payer_vpa` (masked to `am***@okbank` in list views), `fee`, `tax`, `net_amount`, `refunded_amount`, `status`, timestamps, and a `refunds[]` summary.

### 3.3 `GET /v1/payments`

Server-side filters: `status`, `method`, `merchant_order_id`, `payment_id`, `utr`, `rrn`, `provider_id` (admin only), `merchant_id` (platform/reseller users, validated against scope), `amount_min`, `amount_max`, `created_from`, `created_to`. Sort: `created_at` desc (default) or asc. Pagination: `limit` (≤ 100, default 25) + opaque `cursor` (keyset on `created_at, id`).

```json
{ "success": true, "data": [ { "payment_id": "pay_…", "status": "SUCCESS" } ],
  "meta": { "limit": 25, "has_more": true, "next_cursor": "eyJjIjoiMjAyNi0xMC0wNlQx…" } }
```

### 3.4 `POST /v1/payments/:paymentId/refunds`

Headers: `Idempotency-Key` (required).

```json
{ "amount": "250.00", "reason": "Customer returned item", "merchant_refund_id": "RF-778" }
```

`201`: `{ "refund_id": "rfnd_01JA…", "payment_id": "pay_…", "amount": "250.00", "status": "PENDING" }`

### 3.5 Error codes (payin)

| Code | HTTP | When |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | Schema violation, numeric amount, more than 2 decimals, unknown field |
| `UNAUTHORIZED` | 401 | Bad key, signature, or timestamp outside the window |
| `FORBIDDEN` | 403 | IP not whitelisted, or permission missing |
| `MERCHANT_INACTIVE` | 403 | Merchant not `APPROVED` or suspended |
| `KYC_NOT_APPROVED` | 403 | KYC incomplete |
| `PAYIN_DISABLED` | 403 | `payinEnabled = false`, manually or by a risk action |
| `DUPLICATE_ORDER` | 409 | `merchant_order_id` already used with a different idempotency key |
| `IDEMPOTENCY_CONFLICT` | 409 | Same key with a different payload, or the original request is still in progress |
| `LIMIT_EXCEEDED` | 422 | Per-transaction, daily or monthly limit |
| `RISK_BLOCKED` | 422 | Risk rule action `BLOCK` |
| `PROVIDER_UNAVAILABLE` | 503 | No healthy route can serve the method and amount |
| `TRANSACTION_NOT_FOUND` | 404 | Unknown or out-of-scope payment |
| `REFUND_NOT_ALLOWED` | 422 | Status does not allow a refund, or the amount exceeds the refundable amount |
| `RATE_LIMITED` | 429 | Merchant or key rate limit |

## 4. Idempotency

1. `Idempotency-Key` is mandatory on `POST /v1/payments` and on refunds.
2. `requestHash = SHA-256(method + path + canonical JSON body)`. Canonical JSON means sorted keys with no insignificant whitespace.
3. Inside a short transaction, insert `IdempotencyRecord (merchantId, key, hash, status = IN_PROGRESS, expiresAt = now + 24h)`.
   - **Unique violation** → read the existing record:
     - hash differs → `409 IDEMPOTENCY_CONFLICT`.
     - `COMPLETED` → replay the stored `responseStatusCode` + `responseBody` verbatim, with header `Idempotent-Replayed: true`.
     - `IN_PROGRESS` → `409 IDEMPOTENCY_CONFLICT` with message "request in progress, retry later" (the client retries with backoff).
4. The business transaction runs, and the **same** transaction updates the record to `COMPLETED` with the response and `resourceId`. If a business validation fails with a deterministic 4xx (e.g. `LIMIT_EXCEEDED`), the error response is stored as COMPLETED too, so it replays the same answer.
5. A transient 5xx before commit deletes the `IN_PROGRESS` record in a compensating step, so the merchant can retry the same key. If the process crashes, a sweeper removes `IN_PROGRESS` records older than 60 s that have no `resourceId`.
6. Independent backstop: unique `(merchantId, merchantOrderId)` means even a client that rotates idempotency keys cannot create two payments for one order (`DUPLICATE_ORDER`).
7. A Redis fast-path cache of completed responses (TTL 10 min) serves hot retries. PostgreSQL remains the source of truth.

## 5. Creation pipeline

Validation order. Each step is cheap before it is expensive, and nothing calls a provider before the payment row exists.

| # | Step | Failure code |
| --- | --- | --- |
| 1 | Authenticate key + signature + timestamp, IP whitelist, rate limit | `UNAUTHORIZED` / `FORBIDDEN` / `RATE_LIMITED` |
| 2 | Schema validation (Zod), exact amount parse, currency = INR | `INVALID_REQUEST` |
| 3 | Idempotency reservation (§4) | `IDEMPOTENCY_CONFLICT` |
| 4 | Merchant `APPROVED`, not suspended | `MERCHANT_INACTIVE` |
| 5 | KYC approved | `KYC_NOT_APPROVED` |
| 6 | `payinEnabled` | `PAYIN_DISABLED` |
| 7 | Limits (SYSTEM → RESELLER → MERCHANT, most specific wins). Daily/monthly counters in Redis, reconciled from DB. | `LIMIT_EXCEEDED` |
| 8 | Risk pre-check (synchronous fast rules only: velocity, amount anomaly). Heavy rules go to `risk.evaluate` async. | `RISK_BLOCKED` |
| 9 | Routing: ordered candidate providers filtered by health, limits and method | `PROVIDER_UNAVAILABLE` |
| 10 | Pricing resolution → `TransactionPricingSnapshot` (provider cost, platform fee, reseller fee, merchant fee, GST) | — |
| 11 | DB txn: insert `Payment(CREATED)` + snapshot + `PaymentAttempt(INITIATED)` + outbox `payment.created`, then complete the idempotency record. **COMMIT.** | — |
| 12 | Call `PayinProvider.createPayment` (synchronous, timeout 5 s). The QR or intent is needed in the response. | — |
| 13 | Conditional update `CREATED → PENDING`, store QR/intent, provider order ID and attempt result, plus outbox `payment.pending` | — |
| 14 | Respond `201` | — |

**Why the provider call happens after the commit:** a payin creation call moves no money. It only creates a collect request. So a synchronous call is acceptable for latency. Committing first guarantees that any later callback can always find the payment. If step 12 fails definitively (provider rejected the request), the payment moves to `FAILED`. The router may then try **one** fallback provider with a new `PaymentAttempt`, which is safe because no money was requested from the customer under the first attempt. If step 12 times out, the payment stays `CREATED`, the API still returns `201` with `status: "CREATED"` and no QR, and the status poller resolves it. The API never creates a second provider order for an ambiguous attempt.

Ledger: **no postings at creation.** Money only exists once the provider confirms success.

### Creation sequence

```
Merchant        API                       PostgreSQL                  Provider
   |  POST /v1/payments                     |                             |
   |-------------->|  auth/schema/idem      |                             |
   |               |----------------------->| INSERT idempotency(IN_PROG) |
   |               |  merchant/KYC/limits/risk/routing/pricing            |
   |               |----------------------->| BEGIN                       |
   |               |                        |  INSERT payment(CREATED)    |
   |               |                        |  INSERT pricing_snapshot    |
   |               |                        |  INSERT payment_attempt     |
   |               |                        |  INSERT outbox payment.created
   |               |                        |  UPDATE idempotency(COMPLETED*)
   |               |                        | COMMIT                      |
   |               |------------------------------------------------------>| createPayment(pay_…)
   |               |<------------------------------------------------------| qr/intent, provider_order_id
   |               |----------------------->| UPDATE payment SET PENDING WHERE status='CREATED' AND version=v
   |               |                        | INSERT outbox payment.pending
   |<--------------| 201 { payment_id, qr, upi_intent, expires_at }       |
```

\* The stored idempotent response is rewritten to the final `201` body in the step-13 transaction, so replays return the QR too.

## 6. Completion: provider callback → ledger → merchant webhook

```
Provider            API /v1/provider-callbacks/:provider    PostgreSQL           Worker            Merchant
   | POST callback        |                                     |                  |                  |
   |--------------------->| verifyWebhook(raw body, headers)    |                  |                  |
   |                      | store raw callback (provider_callbacks, dedupe key)    |                  |
   |                      | map → normalized status             |                  |                  |
   |                      |------------------------------------>| BEGIN            |                  |
   |                      |   SELECT payment FOR UPDATE         |                  |                  |
   |                      |   check amount/currency/merchant ref match             |                  |
   |                      |   UPDATE status PENDING→SUCCESS (version check)        |                  |
   |                      |   set utr, rrn, payer_vpa, success_at                  |                  |
   |                      |   post journal PAYIN_CAPTURE (idem key payin:pay_X:capture)              |
   |                      |   INSERT outbox payment.success     |                  |                  |
   |                      |   INSERT webhook_event (payment.success)               |                  |
   |                      |------------------------------------>| COMMIT           |                  |
   |<---------------------| 200 (ack fast)                      |                  |                  |
   |                      |                                     | relay → Kafka    |                  |
   |                      |                                     |----------------->| webhook.deliver  |
   |                      |                                     |                  |----------------->| signed POST
```

- The provider callback is acknowledged only **after** commit. If the commit fails, the provider retries, which is safe because processing is idempotent.
- The merchant webhook is always asynchronous (worker), and it never blocks the provider ack or any API response.
- `PAYIN_CAPTURE` credits the merchant's `UNSETTLED` bucket with the net amount and books fees and GST. The posting recipe is in [LEDGER.md](./LEDGER.md).
- The fee recorded on the payment comes **only** from the `TransactionPricingSnapshot` written at creation. It is never recomputed.

### Status polling and expiry sweeper

- **Poller** (worker, every 30 s): payments in `CREATED`/`PENDING` older than 60 s with no callback get `getPaymentStatus()`, with exponential spacing per payment (1 m, 2 m, 5 m, 10 m …) until `expires_at` + grace. Results go through the **same** transition service as callbacks, so there is one code path.
- **Expiry sweeper** (every minute): `PENDING`/`CREATED` payments past `expires_at` + 5 min grace get a final status check, then a conditional move to `EXPIRED`. The sweeper uses `FOR UPDATE SKIP LOCKED` batches so multiple workers can run.

### Late success after EXPIRED / FAILED / CANCELLED

The customer may have paid, so money is **never silently lost**:

1. The callback or poll reports SUCCESS for a payment in `EXPIRED` (or `FAILED`/`CANCELLED`).
2. The policy `payin.late_success_policy` (per merchant, default `AUTO_ACCEPT`) decides:
   - `AUTO_ACCEPT`: the allowed transition `EXPIRED → SUCCESS` with flag `late_success = true` posts `PAYIN_CAPTURE` and emits `payment.success` (the payload includes `late_success: true`).
   - `MANUAL_REVIEW`: the payment stays `EXPIRED`, an `ops_review` item is created plus a risk event, and an operator resolves it to either accept (→ SUCCESS) or auto-refund (→ SUCCESS → REFUND_PENDING).
3. Either way, the provider's record is persisted, so recon flags it if both paths were missed.

## 7. Payment state machine

```
CREATED ──► PENDING ──► SUCCESS ──► SETTLEMENT_PENDING ──► SETTLED
   │           │           │  ▲                                │
   │           ├──► FAILED │  └─ (late success)                │
   │           ├──► EXPIRED┘                                    │
   │           └──► CANCELLED                                   │
   └──► FAILED / CANCELLED / EXPIRED                            │
SUCCESS / SETTLEMENT_PENDING / SETTLED ──► REFUND_PENDING ──► PARTIALLY_REFUNDED / REFUNDED
SUCCESS / SETTLED / PARTIALLY_REFUNDED ──► DISPUTED ──► CHARGEBACK | (back to prior)
```

| From | Allowed to |
| --- | --- |
| `CREATED` | `PENDING`, `FAILED`, `CANCELLED`, `EXPIRED`, `SUCCESS` (callback before step 13) |
| `PENDING` | `SUCCESS`, `FAILED`, `EXPIRED`, `CANCELLED` |
| `FAILED` | `SUCCESS` (late success, policy-gated) |
| `EXPIRED` | `SUCCESS` (late success, policy-gated) |
| `CANCELLED` | `SUCCESS` (late success, policy-gated) |
| `SUCCESS` | `SETTLEMENT_PENDING`, `REFUND_PENDING`, `DISPUTED` |
| `SETTLEMENT_PENDING` | `SETTLED`, `REFUND_PENDING`, `DISPUTED` |
| `SETTLED` | `REFUND_PENDING`, `DISPUTED` |
| `REFUND_PENDING` | `PARTIALLY_REFUNDED`, `REFUNDED`, back to the pre-refund status if every pending refund failed |
| `PARTIALLY_REFUNDED` | `REFUND_PENDING`, `REFUNDED`, `DISPUTED` |
| `REFUNDED` | `DISPUTED` (rare, still tracked) |
| `DISPUTED` | `CHARGEBACK`, the previous financial status (dispute won) |
| `CHARGEBACK` | — (terminal; corrections via adjustment journal) |

Rules:

- The transition table lives in one place (`packages/types` → `PAYMENT_TRANSITIONS`). Every update is `UPDATE … WHERE id = $1 AND status = ANY($allowedFrom) AND version = $v`. Zero rows means re-read, then no-op or report. The code **never overwrites** the status.
- `SUCCESS → PENDING` and any backward move outside the table is rejected and logged as an `INVALID_STATE_TRANSITION` incident.
- Settlement and refund status are partly orthogonal to capture status. `settlementId`/`settledAt` and `refundedAmountMinor` are authoritative, and `status` reflects the most recent significant lifecycle event.

## 8. Refunds

1. Validate the idempotency key (same mechanics as §4, scoped to the merchant).
2. In a transaction: `SELECT payment FOR UPDATE`. Then check that the status is refundable, that `refundedAmountMinor + pendingRefundMinor + amount ≤ amountMinor`, and that the merchant balance can cover it (UNSETTLED first, then AVAILABLE, per LEDGER.md).
3. Insert `Refund(CREATED)` and post a `REFUND` journal stage that reserves funds (recipe in LEDGER.md), move the payment to `REFUND_PENDING`, and write outbox `refund.created`. Commit.
4. A worker calls `refundPayment()` with `rfnd_…` as the provider idempotency reference.
5. On success: refund → `SUCCESS`, finalize the journal, and the payment → `PARTIALLY_REFUNDED`/`REFUNDED`, all under a payment row lock. On a definitive failure: refund → `FAILED`, post a `REVERSAL` of the reservation, and payment status recomputes. On an ambiguous result: stay `PENDING` and poll.

Refund states: `CREATED → PENDING → SUCCESS | FAILED`, plus `MANUAL_REVIEW` for ambiguous cases past the polling window. Fee refund policy (whether the merchant fee is returned on refund) is a pricing configuration captured in the snapshot.

Concurrency: two simultaneous refunds on one payment serialize on the payment row lock, so the over-refund check is exact.

## 9. Disputes and chargebacks

- Disputes arrive via provider callbacks or file import and are stored as `Dispute (payment, amount, reason code, deadline, evidence docs)`.
- `DISPUTED` places a **lien** on the merchant balance for the disputed amount (journal moves funds to `LIEN`, see LEDGER.md).
- Dispute won: release the lien (`REVERSAL`) and restore the prior status.
- Dispute lost: `CHARGEBACK`, the lien converts into a debit, and the amount is deducted in the next settlement as `chargebackMinor`.

## 10. Settlement linkage

- SUCCESS payments accrue in the merchant `UNSETTLED` bucket.
- The settlement job (T0/T1/T2/CUSTOM per `SettlementConfig`) claims payments with `UPDATE payments SET settlement_id = $stl WHERE settlement_id IS NULL AND status IN (...) AND success_at < $cutoff`. Each payment is claimed exactly once.
- Payments move to `SETTLEMENT_PENDING`, then to `SETTLED` with `settledAt` when the settlement is `PROCESSED` (with a UTR). Holds (`SettlementHold`) skip the merchant entirely.

## 11. Reconciliation linkage

- Provider reports (CSV now, API later) are matched on `provider_transaction_id`, then `utr`/`rrn`, then `pay_` ID (which we send as the provider reference).
- Mismatches: `STATUS_MISMATCH` (e.g. provider SUCCESS, ours EXPIRED, the late-success case), `AMOUNT_MISMATCH`, `MISSING_INTERNAL`, `MISSING_PROVIDER` and `DUPLICATE` become `ReconciliationEntry` rows for manual resolution. A resolution that changes money always goes through the state machine plus journals and is never edited directly.

## 12. Failure modes

| Scenario | Behaviour |
| --- | --- |
| Provider timeout on create | Payment stays `CREATED`, the API returns 201 without a QR (`status: CREATED`), and the poller resolves it. No second provider order for the same attempt. |
| Provider definitive reject on create | Attempt `FAILED`, then one fallback attempt if routing allows, otherwise the payment is `FAILED` with an error code |
| Duplicate callback | Provider callback dedupe key (provider + provider txn ID + status) plus the conditional transition, so the second one is a no-op returning 200. Journal idempotency key prevents a double `PAYIN_CAPTURE`. |
| Callback for an unknown payment | Stored in `provider_callbacks` as `UNMATCHED` and returned with 200 (to stop provider retry storms). An alert is raised and recon `MISSING_INTERNAL` picks it up. |
| Amount/currency mismatch in callback | **No** SUCCESS transition. Payment → `MANUAL_REVIEW` flag plus a risk event, recon `AMOUNT_MISMATCH`, and ops is alerted. Ledger is untouched. |
| Callback signature invalid | 401, logged as a security event, nothing persisted beyond a metric |
| Out-of-order callbacks (FAILED after SUCCESS) | The transition table rejects SUCCESS → FAILED, the event is stored and flagged for recon |
| API crash after commit, before provider call | Payment `CREATED` with no attempt result. The poller sees no `provider_order_id` and marks it `FAILED` after the attempt TTL, since the provider was never called. Idempotent replay returns the stored response. |
| Worker crash mid webhook delivery | Kafka offset is not committed, so the message is redelivered, and the delivery attempt is idempotent per (event, endpoint, attempt) |
| DB unavailable on callback | 5xx to the provider, which retries. Nothing is lost. |
| Redis unavailable | Rate limit fails **closed** for public API writes. Limit counters fall back to DB aggregation. Idempotency still works (DB is authoritative). |
