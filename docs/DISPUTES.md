# Disputes and chargebacks

A customer's bank or the card/UPI network can claw a payment back. The platform records each case as a `Dispute`, freezes the money while it is open, lets the merchant answer with evidence, and books the outcome.

## 1. Lifecycle

```
OPEN ──(merchant submits evidence)──▶ UNDER_REVIEW ──▶ WON | LOST
  │                                                      ▲
  └──(merchant accepts)───────────────────────────────────┘ (LOST, no fee)
```

- **Open** (`POST /v1/admin/disputes`, `dispute.manage` + step-up; Operations and Compliance roles).
  - **Body:** `payment_id`, optional `amount` (default: captured minus refunded), `reason_code`, `reason`, `respond_by_days` (1–30, default 7), optional `provider_case_id`.
  - **Allowed on:** `SUCCESS`, `SETTLED` and `PARTIALLY_REFUNDED` payments. A payment in `SETTLEMENT_PENDING` must wait for its settlement.
  - **Limit:** one open dispute per payment (partial unique index).
  - **Effect:** the payment moves to `DISPUTED`.
- **Respond** (merchant `dispute.respond`: Owner, Admin, Finance, Operations):
  - `POST /v1/disputes/:id/evidence` uploads a PDF/PNG/JPEG/WebP, up to 5 MB, 10 per dispute. Files are checked by magic bytes and stored encrypted.
  - `POST /v1/disputes/:id/submit {note}` → `UNDER_REVIEW` (needs at least one file).
  - `POST /v1/disputes/:id/accept` (step-up) → `LOST` with no fee.
- **Decide** (`POST /v1/admin/disputes/:id/resolve`, step-up): `{ outcome: 'WON' | 'LOST', note, fee? }`. GST of 18 % is added to any fee.
- **Read:** `GET /v1/disputes`, `/summary`, `/:id` and `/:id/evidence/:evidenceId`. Evidence downloads are audited, sent as attachments with a sandbox CSP.

## 2. Money (docs/LEDGER.md §4.5)

| Step | Journal | Lines |
| --- | --- | --- |
| Open | `CHARGEBACK_LIEN` | Dr merchant AVAILABLE, then UNSETTLED, then RECEIVABLE (what the merchant can't cover) / Cr merchant LIEN = disputed amount. The split is stored on the dispute (`lien_sources`). |
| Won | `CHARGEBACK_RELEASE` | Dr LIEN / Cr exactly the buckets it came from (AVAILABLE, UNSETTLED, RECEIVABLE) |
| Lost | `CHARGEBACK_DEBIT` | Dr LIEN / Cr provider clearing (the amount goes back to the provider). Optional fee: Dr AVAILABLE (then RECEIVABLE) / Cr FEE_REVENUE + GST_PAYABLE |

Payment status:
- **Lost:** `CHARGEBACK` (final).
- **Won:** returns to the status before the dispute, or `SETTLED` if a settlement claimed the payment while it was disputed.

Settlement is balance-based, so money frozen from UNSETTLED is simply not paid out.

## 3. Notifications and webhooks

- Webhook events `dispute.created`, `dispute.updated` (submitted), `dispute.won`, `dispute.lost` carry the dispute object.
- **Merchant inbox (DISPUTE):**
  - on opening (critical, with the deadline);
  - a reminder 2 days before the deadline (`dispute-reminders` job, every 6 h);
  - on the outcome.
- **Platform inbox:** when evidence is submitted and when a deadline passes without a response.

## 4. Not yet included

- Disputes are opened by platform staff from the bank's notice; there is no automatic import from provider dispute APIs or webhooks yet.
- A RECEIVABLE balance (merchant owes) is reported but not yet netted automatically from the next settlement.
