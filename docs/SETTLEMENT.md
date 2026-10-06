# Settlement & Reconciliation

> Status: implemented in Phase 8. Related: [LEDGER.md](./LEDGER.md) §4.2–4.3, [PAYIN_FLOW.md](./PAYIN_FLOW.md) §10–11

## 1. Schedule

Each merchant has a `SettlementConfig`. Until finance saves an explicit one, these defaults apply:
- the cycle the merchant chose at onboarding (default T1);
- an 18:00 IST cutoff;
- a ₹1 minimum;
- the bank as destination if a verified settlement account exists, otherwise the payout wallet.

| Cycle | Payments included in the run on IST date R |
| --- | --- |
| T0 | captured before R's cutoff |
| T1 | captured before the cutoff of R − 1 |
| T2 | captured before the cutoff of R − 2 |
| CUSTOM (3–7 days) | captured before the cutoff of R − N |

- **When it runs.** The run for date R becomes due once R's cutoff has passed. The generator in the API jobs process checks every 5 minutes. There is **one settlement per merchant per IST date** (unique constraint), so re-runs and replicas are harmless.
- **Calendar.** Days are calendar days. Bank-holiday calendars arrive with Phase 10.
- **Skips:** a merchant is skipped when it is suspended, has an active **hold**, has automatic settlement turned off, has a BANK destination without a verified account, or would settle less than its minimum. In that last case the amount carries forward.

## 2. How much is settled

Refunds draw from the merchant's pooled `UNSETTLED` balance, UNSETTLED first and then AVAILABLE. So "the sum of the settled payments' nets" is not always available. The amount is therefore defined on the balance:

```
reserve = Σ over unsettled payments captured AFTER the period end of
            max(0, net − refunds that payment drew from UNSETTLED)
amount  = max(0, UNSETTLED balance − reserve)
```

- The amount can never be negative, and it never takes money that belongs to later payments.
- Refunds and their reversals are counted exactly from the ledger (`REFUND` / `REFUND_REVERSAL` entries on the merchant's UNSETTLED account).
- Payments captured before the period end are **claimed** (`settlement_id`) to explain the settlement: gross, fees, GST and refunds are reported from them.

Everything happens inside one ledger transaction holding the merchant's UNSETTLED row lock. That serialises the run with captures and refunds for that merchant.

## 3. Destinations and journals

| Step | Journal | Lines |
| --- | --- | --- |
| Wallet settlement | `SETTLEMENT` | Dr merchant UNSETTLED / Cr merchant AVAILABLE |
| Bank: at creation (status PROCESSING) | `SETTLEMENT_TRANSFER` | Dr merchant UNSETTLED / Cr `platform:SETTLEMENT_CLEARING` |
| Bank: confirmed with a UTR (PROCESSED) | `SETTLEMENT_PAID` | Dr SETTLEMENT_CLEARING / Cr `platform:bank:nodal`, plus memo Dr SETTLED_CONTRA / Cr merchant SETTLED |
| Bank: transfer failed (FAILED) | `SETTLEMENT_RETURN` | Dr SETTLEMENT_CLEARING / Cr merchant UNSETTLED |

- **Bank transfers are reserved at creation.** Funds leave UNSETTLED immediately, so money that is in flight to the merchant's bank can't also be refunded.
- **Payment statuses.**
  - Wallet: `SUCCESS → SETTLEMENT_PENDING → SETTLED` in the same transaction.
  - Bank: payments stay `SETTLEMENT_PENDING` until PROCESSED. If the transfer fails, they return to `SUCCESS`, are unclaimed, and settle again in the next run.
  - Refunded payments keep their refund status. `settlement_id` and `settled_at` are authoritative.
- **Events.** `settlement.processed` and `settlement.failed` merchant webhooks.

### Bank transfer operations (finance)

- **Transfer file.** `GET /v1/settlements/transfer-file` lists the PROCESSING bank settlements with **full** account numbers, formatted for the bank's bulk upload. Requirements:
  - platform users with `settlement.process` only;
  - an MFA-verified session;
  - every export is audited with the settlement ids.

  This is the only place settlement account numbers are decrypted.
- **Outcome.** Once the bank confirms, finance records the UTR (**Mark paid**) or the failure. Merchants can download each settlement's statement as CSV.

## 4. Provider remittances

When a provider remits collections to our bank net of its cost, finance records it once per reference (`POST /v1/settlements/remittances`). This posts `PROVIDER_SETTLEMENT`: Dr bank (received) and Dr PROVIDER_COST (cost) / Cr provider clearing (gross). Comparing a provider's clearing balance with what it still owes is part of reconciliation.

## 5. Reconciliation

**Statement format.** Generic provider-statement CSV, up to 10 MB:

| Column | Required | Notes |
| --- | --- | --- |
| `reference` | yes | our `pay_…` / `pout_…-n` reference or the provider's order/reference |
| `amount` | yes | rupee string |
| `status` | yes | success / failed / pending / reversed and their synonyms |
| `date` | yes | ISO timestamp or `YYYY-MM-DD` (IST) |
| `provider_txn_id`, `utr`, `rrn` | no | used first for matching |

A provider adapter whose report differs maps it onto this format.

**Import.** The file is stored in S3 (SSE) and de-duplicated per provider by SHA-256. It is matched asynchronously by the jobs process.

**Matching:**
- **Collections:** provider transaction id → UTR/RRN → our reference (payment id / provider order id), scoped to the provider.
- **Payouts:** UTR → attempt reference / provider reference / payout id.
- "Succeeded" means money moved on our ledger (a capture or settle journal exists).

| Result | Meaning |
| --- | --- |
| `MATCHED` | same outcome and amount |
| `AMOUNT_MISMATCH` | outcome agrees, amount differs |
| `STATUS_MISMATCH` | one side succeeded and the other didn't (e.g. the provider was paid after we expired the payment) |
| `MISSING_INTERNAL` | the provider reports something we have no record of (or the row is unparseable) |
| `MISSING_PROVIDER` | we moved money that the statement (for its period) doesn't mention |
| `DUPLICATE` | the same transaction appears twice in the file |

**Resolution.** Matching **never changes money.** Every non-matched row is an OPEN exception that a person resolves with a note (audited). There is one money-moving shortcut: for a payment `STATUS_MISMATCH` where the provider reports success **for exactly our amount**, *Accept provider success* captures the payment through the normal state machine (late success, ledger capture, merchant webhook). Everything else (amount differences, payout mismatches) is fixed through existing controls: payout manual review and maker-checker ledger adjustments.

## 6. Deferred

- A bank holiday calendar (Phase 10).
- Settlement transfers through a banking API instead of a file plus UTR confirmation.
- Per-provider statement parsers beyond the generic format.
- Automatic MISSING_INTERNAL recovery from stored provider callbacks.
- On-demand / instant settlement.
- Chargebacks deducted in settlements (with disputes).
