# GST tax invoices

Each merchant gets one GST tax invoice per calendar month (IST) for the platform's fees. The GST was already charged on every transaction and deducted from what the merchant received; the invoice consolidates it for the month, so the merchant can claim input tax credit.

## 1. Setup

Settings → **Tax & invoices** (`system.settings.manage`, step-up): legal name, GSTIN, PAN, registered address, SAC (default `997159`) and an invoice prefix (2–5 characters).
- The state code must equal the GSTIN's first two digits (validated and enforced by a DB CHECK).
- Nothing is invoiced until this is saved.

## 2. Issuing

- **Automatic:** the `invoice-generator` job (hourly) issues the previous month's invoices for every merchant with fees, from the 1st (IST).
- **Manual:** `POST /v1/admin/invoices/generate {month, merchant_id?}` (`settlement.process`) issues a completed month now. Re-running is a no-op: one invoice per merchant and month (unique index).
- **Lines** (only those with fees):

  | Line | Source |
  | --- | --- |
  | Payin fees | `payments.fee_minor` / `tax_minor` of captured payments with `success_at` in the month (the scheme / pricing fee charged at capture) |
  | Payout fees | payouts with status `SUCCESS` or `REVERSED` (fee kept on a bank return) and `processed_at` in the month |
  | Chargeback fees | disputes `LOST` with a fee, `resolved_at` in the month |

- **Tax split:** place of supply is the merchant's state, from its GSTIN or else its registered-address state, falling back to the supplier's state.
  - Same state as the platform: CGST and SGST, half each (the odd paisa goes to SGST).
  - Another state: IGST.
- **Numbers:** `PREFIX + FY + '-' + serial`, e.g. `P2A2627-000042`.
  - At most 16 characters (GST rule 46).
  - Consecutive per financial year (April–March, by issue date), from a counter row locked in the issuing transaction, so a failed issue leaves no gap.
- **Snapshots:** supplier and recipient details are stored as they were at issue.
- **Immutable:** invoices can't be updated or deleted (DB trigger).

## 3. Reading

- **API:** `GET /v1/invoices` (filter `month`, `merchant_id` for platform) and `GET /v1/invoices/:id` (`report.read`, tenant-scoped).
- **Dashboard:** merchants use Accounts → Tax invoices; platform staff use Tax invoices.
- **The invoice page** prints cleanly ("Print / save as PDF"). It also shows, for the merchant's reference only:
  - the scheme commission credited that month (not part of the invoice);
  - the taxable value, for TDS where the merchant must deduct it.
- **Notification:** the merchant gets an inbox notice when an invoice is issued.

## 4. Not yet included

- **Credit notes** (for fee refunds or corrections). An issued invoice is never changed.
- **E-invoicing** (IRN / QR from the GST Invoice Registration Portal), which applies above the turnover threshold. It needs a GSP integration.
- **PDF files** generated on the server; the browser's print-to-PDF is used.
