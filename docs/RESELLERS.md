# Resellers: Rate Cards & Commissions

> Status: implemented in Phase 9. Related: [LEDGER.md](./LEDGER.md) §4.12, [API.md](./API.md) §4

## Hierarchy

A reseller organization sits under the platform, and its merchants sit under it (`organizations.parent_id`, with `merchants.reseller_id` denormalised onto each transaction). Resellers see their own merchants' data, and nothing else (tenant scope). Platform staff create resellers and can move a new merchant under one.

## Pricing

| Plan kind | Owner | Meaning |
| --- | --- | --- |
| `WHOLESALE` | platform | what Pay2All charges the reseller (assigned per reseller, or the platform default) |
| `MERCHANT` | platform **or reseller** | what a merchant is charged |

- **Rate cards.** Resellers create **merchant rate cards** for their own merchants and can mark one as their default. Resolution order: the merchant's assignment, then the reseller's default, then the platform default.
- **Floor.** A rate card is refused if it is **below the reseller's wholesale price**. The check computes both plans' fees for every targeted service and method at ₹100, ₹1,000, ₹10,000, ₹1,00,000 and ₹5,00,000.
- **Ownership.** Resellers can archive and assign **only their own** cards, and only to **their own** merchants. Before Phase 9, any holder of `pricing.manage` could archive or assign any plan, including the platform default; that is fixed and covered by a regression test.
- **History.** Every transaction stores a pricing snapshot, so later changes never alter history.

## Commissions

- **Margin.** The reseller margin per transaction (merchant fee − wholesale fee, excluding GST) is fixed in the transaction's pricing snapshot.
- **Accrual.** Once money has actually moved (a payin is captured, or a payout completes), the commission sweeper (jobs process, every minute) posts `COMMISSION_ACCRUAL`: Dr `platform:COMMISSION_EXPENSE` / Cr `reseller:<id>:COMMISSION_PAYABLE`. The key `commission:<txn>` makes it exactly-once across retries and replicas. Fees aren't returned on refunds or payout reversals, so commissions are not clawed back.
- **Payout.** Finance records a commission transfer with its UTR (unique per reseller): `COMMISSION_PAYOUT`, Dr reseller payable / Cr bank. The ledger refuses to pay out more than has accrued. The engine also enforces direction: accruals only credit, and payouts only debit, a reseller payable.
- **Reseller dashboard:**
  - Earnings: the payable balance, this month's accruals, lifetime accruals and payouts, and the payout history.
  - Commissions: margins per merchant for a month.
- **Admin.** Resellers → Commissions shows every reseller's payable balance and lets finance record a payout.

GST on commissions (reverse charge vs invoice) remains a finance decision. Additional journal lines can be added without changing the model.
