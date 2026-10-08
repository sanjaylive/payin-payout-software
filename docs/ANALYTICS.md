# Analytics

The **Analytics** page is available to merchants (`/analytics`), resellers (`/reseller/analytics`) and the platform (`/admin/analytics`). It shows how payins and payouts are converting, why they fail, and when traffic peaks. The page refreshes every 30 seconds.

## 1. Definitions

The same definitions are used by the dashboard stats (`/v1/payments/stats`, `/v1/payouts/stats`).

| | Payin | Payout |
| --- | --- | --- |
| Success | Captured to the ledger (`capture_journal_id` set) | Settled (`settle_journal_id` set) |
| Failed | `FAILED` or `EXPIRED` | `FAILED` |
| Success rate | success ÷ (success + failed) | success ÷ (success + failed) |

Transactions still in flight count towards the totals but are left out of the success rate, so a burst of new payments does not look like a drop.

All times are IST. A range covers at most 92 days. Transactions are assigned to a range by their creation time.

## 2. What is shown

- **Totals:** count, success rate, successful volume and average ticket.
- **Live:** the last 15 minutes, regardless of the selected range.
- **By method:** payin method (UPI QR, intent, static QR and so on) or payout mode (IMPS, NEFT, RTGS).
- **By gateway:** **platform users only.** Gateway names are internal and never shown to merchants or resellers. The gateway counted is the one that finally handled the transaction, so after a failover the transaction counts against the gateway that took it.
- **Failure reasons:** the top 10 `failure_code` values, with a sample reason and their share of failures. Expired payins are grouped as `EXPIRED`.
- **Busiest hours:** 24 hour-of-day buckets combining every day in the range, plus the peak hour.

## 3. API

`GET /v1/analytics?kind=payin|payout&from=<iso>&to=<iso>[&merchant_id=]`

Access:
- Requires `report.read`, plus `payin.read` or `payout.read` for the requested `kind`.
- The scope comes from the session: a merchant sees itself, a reseller sees its merchants, and the platform sees everything.
- `merchant_id` narrows the scope but can never widen it. A merchant outside the caller's scope returns 404.

Money values are rupee strings and rates are fractions rounded to 4 decimals. A rate is `null` when nothing has completed.

## 4. Performance

The queries run directly against `payments` and `payouts`, using the `(merchant_id, created_at)`, `(reseller_id, created_at)` and `(created_at)` indexes. Across the whole platform, a 92-day range scans every row in that range.

If volume grows, move this page to a read replica, or to hourly rollups like `ProviderHealthSnapshot`, before widening the range limit.
