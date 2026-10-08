# Pricing schemes

A **scheme** sets the price of each transaction for the merchants on it. It does this per **pricing provider** and per amount slab. Each value is either a **charge** or a **commission**, and is given as **%** or **flat ₹**.

| Where | What |
| --- | --- |
| **Settings → Pricing Providers** | The numbered pricing lines that schemes price. Super admins only (`system.settings.manage`). |
| **Pricing → Schemes** | Create, edit, duplicate, make default, archive. Requires `pricing.manage`. |
| **Merchants → Schemes** | The default scheme, applying a scheme to all merchants, and per-merchant or bulk assignment. |
| **Merchant → Pricing tab** | What prices this merchant now, and changing its scheme. |

All of this is for platform staff only. Every change needs a reason and is written to the audit log.

## 1. Pricing providers

A pricing provider is a **numbered line** that covers a service and some of its methods. It is not a bank or PSP; those are `providers` and are used for routing.

| # | Name | Service | Methods |
| --- | --- | --- | --- |
| 1 | Payout | PAYOUT | IMPS, NEFT, RTGS, UPI |
| 2 | Dynamic QR | PAYIN | UPI_QR, UPI_INTENT, PAYMENT_LINK |
| 3 | Static QR | PAYIN | UPI_STATIC_QR |

These three are created by the migration. Super admins can add more, for example `4 = Virtual Account`.

- **How a transaction is matched:** a transaction is priced by the **active** provider that covers its method. A method can belong to only one active provider.
- **Static QR:** `UPI_STATIC_QR` can be priced now, but static-QR collections are not live yet.
- **Service lock:** a provider's service can't change once any scheme prices it.
- **Switching off:** a provider can be switched off only when no active scheme prices it.
- **Removing:** a provider can be removed only when no scheme, including archived ones, has ever priced it.

## 2. Schemes

Each scheme has:
- a **name**, unique among active schemes;
- an optional description;
- a **GST rate**, 18% by default;
- a list of **rates**.

Each rate has these fields:

| Field | Meaning |
| --- | --- |
| `provider_id` | The pricing provider number. |
| `min_amount`, `max_amount` | The slab in rupees. Both ends are included. `max_amount: null` means no upper limit. |
| `type` | `PERCENT` or `FLAT`. |
| `value` | A signed string. **Negative = charge to the merchant. Positive = commission to the merchant.** `0` = free. |

Examples:
- `"-2"` with FLAT is a ₹2.00 charge.
- `"-0.5"` with PERCENT is a 0.5% charge.
- `"3"` with FLAT is a ₹3.00 commission.

Slab and value rules:
- **No overlaps:** slabs for the same provider must not overlap. The API rejects overlaps, and the editor highlights them as you type.
- **Gaps:** gaps are allowed, and the editor warns about them.
- **Uncovered transactions are refused:** a transaction whose provider or amount has no slab is refused with `PAYIN_DISABLED` / `PAYOUT_DISABLED`. The message says which scheme, provider and amount had no rate.
- **Value limits:** flat values have 2 decimals and go up to ±₹1,00,000. Percentages have 4 decimals and go up to ±100%. Amounts and values must be strings; JSON numbers are rejected.

### 2.1 Editing and history

- **Editing:** an edit replaces all of a scheme's rates in one transaction, with an optimistic version check. A stale edit returns 409.
- **No effect on past transactions:** fees already charged never change. Each transaction stores a pricing snapshot (`transaction_pricing_snapshots.pricing.scheme`) with the scheme, its version, the provider, and the exact slab and value used.
- **Archiving:** archiving is blocked while the scheme is the default or has assigned merchants.

## 3. Charge vs commission

| | Charge (value < 0) | Commission (value > 0) |
| --- | --- | --- |
| Payin | `net = amount − fee − GST` | `net = amount + commission` (no GST) |
| Payout | `debit = amount + fee + GST` | `debit = amount − commission` (no GST) |

The arithmetic is exact:
- percentages are rounded HALF_UP to the paisa, once per component;
- GST is charged on charges only.

A transaction has either a fee or a commission, never both. Database `CHECK` constraints on `payments` and `payouts` enforce this. A payout's commission must be smaller than its amount.

### 3.1 Ledger

Commission is a platform expense, posted to `platform:MERCHANT_COMMISSION` (EXPENSE, normal DR).

| Event | Postings |
| --- | --- |
| Payin captured | Dr provider clearing `amount`, Dr MERCHANT_COMMISSION `c`, Cr merchant UNSETTLED `amount + c` |
| Payout sent | Dr merchant RESERVED `amount − c`, Dr MERCHANT_COMMISSION `c`, Cr provider clearing `amount` |
| Payout returned by the bank | Dr provider clearing `amount`, Cr merchant AVAILABLE `amount − c`, Cr MERCHANT_COMMISSION `c`. The commission is taken back. |
| Payin refund | Cr provider clearing `refund`, Cr MERCHANT_COMMISSION `clawback`, Dr merchant `refund + clawback` |

**Refund claw-back:**
- Each refund takes back the commission in proportion to the amount refunded so far, so a full refund recovers exactly the commission credited.
- Each refund records its share in `refunds.commission_clawback_minor`.
- A failed refund's reversal mirrors its journal, so the claw-back is returned with it.

This stops anyone from earning commission by paying themselves and then refunding.

## 4. Which pricing applies

For each transaction, the first match in this list wins:

1. The merchant's **assigned scheme** (`merchants.scheme_id`).
2. A **rate card** explicitly assigned to the merchant, under Merchants → Schemes → Rate cards.
3. For a reseller's merchant, the reseller's default **rate card**.
4. The **default scheme**. At most one scheme can be the default, enforced by a partial unique index.
5. The platform's default merchant **rate card**.

**Joining the default:** new merchants have no assigned scheme, so they join the default scheme automatically, unless they belong to a reseller (step 3).

**Resellers:**
- When a scheme prices a reseller's merchant, the reseller layer is skipped: no wholesale fee is applied and the reseller earns no margin.
- So **Apply to all** leaves resellers' merchants alone unless *Include resellers' merchants* is switched on.

## 5. API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/pricing-providers` | `pricing.read` | Providers, with the number of active schemes that use each |
| `POST /v1/pricing-providers` | `system.settings.manage` | `{ name, service, methods[], description?, is_active, reason }` |
| `PUT /v1/pricing-providers/:id` | `system.settings.manage` | Same body |
| `POST /v1/pricing-providers/:id/remove` | `system.settings.manage` | `{ reason }` |
| `GET /v1/schemes` | `pricing.read` | `{ schemes[], merchants_without_scheme }` |
| `GET /v1/schemes/:id` | `pricing.read` | A scheme and its rates |
| `POST /v1/schemes` / `PUT /v1/schemes/:id` | `pricing.manage` | `{ name, description?, tax_rate, rates[], version?, reason }` |
| `POST /v1/schemes/:id/archive` | `pricing.manage` | `{ reason }` |
| `POST /v1/schemes/default` | `pricing.manage` | `{ scheme_id \| null, reason }` |
| `POST /v1/schemes/assign` | `pricing.manage` | `{ scheme_id \| null, target: MERCHANTS \| ALL, merchant_ids[], include_reseller_merchants, reason }` |
| `GET /v1/schemes/merchants` | `pricing.read` + `merchant.read` | Merchants with their assigned scheme and the pricing in effect (`q`, `scheme` = id \| `none`, cursor) |
| `GET /v1/schemes/merchants/:merchantId` | `pricing.read` + `merchant.read` | A merchant's assigned scheme, the pricing in effect, and its rates |
| `POST /v1/schemes/preview` | `pricing.read` | `{ scheme_id \| merchant_id, method, amount }` returns the fee, GST, commission and merchant net |

Payment and payout responses now include `commission` alongside `fee` and `tax`.

## 6. Not yet included

- **Scheduled changes:** a scheme edit applies at once; there is no "effective from" date. Use a new scheme and assign it when needed.
- **Reseller-owned schemes:** resellers keep using rate cards for their merchants.
- **Commission on reports:** each monthly tax invoice shows the commission credited that month (docs/INVOICES.md); settlement statements don't break it out yet. It is in the ledger, payment and payout records, and pricing snapshots.
