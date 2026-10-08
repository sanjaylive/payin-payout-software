# Double-Entry Ledger

> Every rupee that moves through Pay2All Payments is a balanced, immutable journal. Balances are a *consequence* of the ledger and are never edited directly.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) (ADR-2, ADR-5, ADR-6), [DATABASE.md](./DATABASE.md) §2.3 and §4, [PAYIN_FLOW.md](./PAYIN_FLOW.md), [PAYOUT_FLOW.md](./PAYOUT_FLOW.md).

## 1. Principles

1. **Double entry.** A financial event is one `ledger_journals` row plus at least two `ledger_entries` rows. For every journal and **every currency in it**, Σ debits = Σ credits.
2. **Immutability.** Posted journals and entries are never `UPDATE`d or `DELETE`d. Database triggers enforce this (ADR-6), so a code bug or an ad-hoc SQL session cannot rewrite history.
3. **Corrections by new journals only.** A mistake is fixed with a **reversal journal**, an exact mirror that links through `reverses_journal_id`, or an **adjustment journal** that goes through maker-checker (§8).
4. **Positive amounts, explicit direction.** `amount_minor > 0` always. The sign comes from `direction ∈ {DEBIT, CREDIT}`, and the schema has no negative entry amounts.
5. **Idempotent posting.** Every journal carries a unique, deterministic `idempotency_key` (e.g. `payout:pout_01J…:reserve`). Posting the same key twice returns the first journal and never creates a second one (§7).
6. **Synchronous where balance matters (ADR-5).** A posting that changes a merchant's *spendable* position is written in the same database transaction as the business row that caused it: payin credit, payout reserve/settle/release, refund, chargeback, settlement or adjustment. Kafka (`ledger.post`) is used only for derived, non-spendable postings such as reseller commission accrual.
7. **Defence in depth.** The application validates balance before inserting. The database re-validates at commit with a deferred constraint trigger.

### 1.1 Database guards (sketch, shipped in the Phase 3 migration)

```sql
-- (a) Immutability: entries and journals are append-only.
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER ledger_entries_immutable  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

-- (b) Balance: checked once the transaction commits, so all lines of a journal
--     can be inserted in any order before validation runs.
CREATE FUNCTION ledger_assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT currency,
         SUM(CASE WHEN direction = 'DEBIT'  THEN amount_minor ELSE 0 END) AS dr,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END) AS cr,
         COUNT(*) AS n
    INTO bad
    FROM ledger_entries
   WHERE journal_id = NEW.journal_id
   GROUP BY currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % unbalanced in %: dr=% cr=%',
      NEW.journal_id, bad.currency, bad.dr, bad.cr USING ERRCODE = 'P0002';
  END IF;
  IF (SELECT COUNT(*) FROM ledger_entries WHERE journal_id = NEW.journal_id) < 2 THEN
    RAISE EXCEPTION 'journal % has fewer than 2 entries', NEW.journal_id USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced();

-- (c) Row-level sanity.
ALTER TABLE ledger_entries  ADD CONSTRAINT ledger_entries_amount_positive CHECK (amount_minor > 0);
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_non_negative
  CHECK (allow_negative OR balance_minor IS NULL OR balance_minor >= 0);
```

The constraint trigger is row-level, so it re-checks a journal once per entry. Journals have 2–6 lines and `(journal_id)` is indexed, so the cost is a handful of index lookups per posting. That is acceptable, and it is benchmarked in Phase 10.

## 2. Money representation

| Concern | Rule |
| --- | --- |
| Storage | `BIGINT` minor units (paise) in `*_minor` columns. In TypeScript, `bigint` only. A `number` must never hold an amount. |
| API boundary | Amounts are parsed from **strings** in major units (`"1000.00"`) or integer minor units, depending on the public API decision recorded in PAYIN_FLOW.md. They are converted to `bigint` minor units immediately by `Money.parse`. JSON floats are rejected for amount fields. |
| Rates | `NUMERIC(12,6)` percent, handled as a scaled integer (`rate × 10^6`) in code. There is no `Decimal`→`number` conversion. |
| Rounding | **ROUND_HALF_UP to the paise** for fee and tax computation. It is the convention Indian banks and GST invoices use, finance teams can reproduce it in a spreadsheet, and it is deterministic. Banker's rounding would make individual-transaction fees surprising to merchants. Rounding happens **once per computed component** (fee, then tax on the rounded fee), and the components are stored in the pricing snapshot so they are never recomputed. |
| Currency | ISO-4217 `CHAR(3)` on every amount. INR (exponent 2) only at launch. A currency registry maps code → minor-unit exponent. Mixed-currency arithmetic throws, and FX would require explicit FX journals (out of scope). |

Planned `packages/ledger/src/money.ts` API:

```ts
type CurrencyCode = 'INR';                         // widened when a currency is enabled
interface Money { readonly minor: bigint; readonly currency: CurrencyCode }

Money.of(minor: bigint, currency: CurrencyCode): Money        // asserts integer, currency known
Money.parse(major: string, currency: CurrencyCode): Money     // "1000.5" → 100050n; >2 dp → error
Money.format(m: Money, opts?: { symbol?: boolean }): string   // "₹1,000.50" (en-IN grouping)
Money.toMajorString(m: Money): string                         // "1000.50" for API responses
add(a, b) / sub(a, b) / neg(a) / cmp(a, b) / isZero(a) / isPositive(a)   // same-currency only
sum(list: Money[], currency): Money

// rateMicros: percent × 10^6, e.g. 0.18 % → 180_000n
percentOf(amount: Money, rateMicros: bigint, mode: 'HALF_UP'): Money
//   fee = amount.minor × rateMicros / (100 × 10^6), rounded HALF_UP
taxOn(fee: Money, taxRateMicros: bigint): Money                // GST on the rounded fee, HALF_UP
clamp(value: Money, min?: Money, max?: Money): Money            // PERCENTAGE_WITH_MIN_MAX
```

Worked example: ₹1,000.00 payin at 0.18 % with GST 18 %:
`fee = 100000 × 0.18 % = 180 paise`, `GST = 180 × 18 % = 32.4 → 32 paise`, `net = 100000 − 180 − 32 = 99788`.

## 3. Chart of accounts

### 3.1 Sign convention

Each account has a `normal_balance`. **ASSET** and **EXPENSE** accounts are DEBIT-normal. **LIABILITY**, **REVENUE** and **EQUITY** accounts are CREDIT-normal. **CLEARING** accounts are ASSET-like (DEBIT-normal) and should net to zero over a settlement cycle.

`balance_minor = Σ(normal-side entries) − Σ(opposite-side entries)`, so a healthy merchant AVAILABLE account, which is CREDIT-normal, shows a positive balance.

### 3.2 Platform accounts (owner = PLATFORM)

| Code pattern | Type | Normal | Maintained balance? | Purpose |
| --- | --- | --- | --- | --- |
| `platform:provider:<prv>:CLEARING` | CLEARING | DR | No (aggregated) | What a provider owes us (payins) or we have pre-funded with it (payouts). One per provider. |
| `platform:bank:<bank_acct_id>` | ASSET | DR | No | Settlement and escrow bank account. **Configurable:** this may be a partner bank's nodal/escrow account held for merchants rather than a Pay2All-owned account. The account's `metadata.legal_holder` records which. |
| `platform:bank:<collection account id>` | ASSET | DR | No | Fund accounts merchants pay into to load their wallet; debited by `FUND_LOAD` (docs/FUND_REQUESTS.md). |
| `platform:FEE_REVENUE` | REVENUE | CR | No | Merchant fees earned. |
| `platform:GST_PAYABLE` | LIABILITY | CR | No | Output GST collected on fees. |
| `platform:PROVIDER_COST` | EXPENSE | DR | No | Provider MDR and payout charges. |
| `platform:COMMISSION_EXPENSE` | EXPENSE | DR | No | Reseller commissions earned on Pay2All's fee. |
| `platform:MERCHANT_COMMISSION` | EXPENSE | DR | No | Commission paid to merchants by pricing schemes; taken back on refunds and payout returns (docs/PRICING_SCHEMES.md §3.1). |
| `platform:ADJUSTMENT_SUSPENSE` | CLEARING | DR | No | Counter-leg for manual adjustments, cleared by finance against a reference. |
| `platform:SUSPENSE` | CLEARING | DR | No | Unidentified money (e.g. recon `MISSING_INTERNAL`). Must trend to zero. |
| `platform:memo:SETTLED_CONTRA` | CLEARING (memo) | DR | No | Contra for the memo SETTLED bucket (§3.3). |

### 3.3 Per-merchant accounts (owner = MERCHANT)

These are **LIABILITY** accounts. They represent money owed *to the merchant* by whoever legally holds it: Pay2All or the regulated partner holding funds in nodal/escrow. The ledger records the obligation and does not claim ownership of the underlying funds.

| Code | Bucket | Normal | Lockable / maintained | `allow_negative` | Meaning |
| --- | --- | --- | --- | --- | --- |
| `merchant:<id>:PENDING` | PENDING | CR | Yes | false | Captured payins not yet eligible for settlement, e.g. under risk hold or awaiting provider confirmation. |
| `merchant:<id>:UNSETTLED` | UNSETTLED | CR | Yes | false | Eligible payins (net of fee + GST) awaiting the settlement cycle. |
| `merchant:<id>:AVAILABLE` | AVAILABLE | CR | Yes | **false** | Spendable payout wallet. **The only account a payout can draw from.** |
| `merchant:<id>:RESERVED` | RESERVED | CR | Yes | false | Funds earmarked for in-flight payouts. |
| `merchant:<id>:LIEN` | LIEN | CR | Yes | false | Funds frozen for disputes or risk actions. |
| `merchant:<id>:SETTLED` | SETTLED | CR (memo) | Yes | false | Memo: cumulative amount settled to the merchant's bank. It is posted as a balanced memo pair with `SETTLED_CONTRA` and excluded from the financial balance sheet. |
| `merchant:<id>:RECEIVABLE` | — | DR (ASSET) | Yes | true | Amounts the merchant owes us when a debit exceeds AVAILABLE (e.g. a chargeback). |

Resellers get `reseller:<id>:COMMISSION_PAYABLE` (LIABILITY, CR, maintained). All accounts are created lazily and idempotently by the code (unique `code`) the first time they are needed, inside the posting transaction.

## 4. Posting recipes

Amounts are in ₹ for readability and in paise in storage. Every table balances: Σ Dr = Σ Cr. Journal `type` and `idempotency_key` are shown in each heading.

### 4.1 Payin success: `PAYIN_CAPTURE`, key `payment:<pay>:capture`

₹1,000 payin, merchant fee 0.18 % = ₹1.80, GST 18 % on fee = ₹0.32.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `platform:provider:<prv>:CLEARING` | 1,000.00 |
| Cr | `merchant:<id>:UNSETTLED` (or `PENDING` if under hold) | 997.88 |
| Cr | `platform:FEE_REVENUE` | 1.80 |
| Cr | `platform:GST_PAYABLE` | 0.32 |

### 4.2 Provider settles to our bank: `PROVIDER_SETTLEMENT`, key `provider_stl:<prv>:<ref>`

The provider remits ₹999.00 after keeping its 0.10 % cost (₹1.00).

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `platform:bank:<acct>` | 999.00 |
| Dr | `platform:PROVIDER_COST` | 1.00 |
| Cr | `platform:provider:<prv>:CLEARING` | 1,000.00 |

### 4.3 Merchant settlement: `SETTLEMENT`, key `settlement:<stl>`

**(a) To the payout wallet** (merchant chose wallet mode):

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:UNSETTLED` | 997.88 |
| Cr | `merchant:<id>:AVAILABLE` | 997.88 |

**(b) To the merchant's bank account:**

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:UNSETTLED` | 997.88 |
| Cr | `platform:bank:<acct>` | 997.88 |
| Dr | `platform:memo:SETTLED_CONTRA` | 997.88 |
| Cr | `merchant:<id>:SETTLED` (memo) | 997.88 |

**(c) As implemented (Phase 8), bank settlements go through transit,** so funds can't be refunded while the transfer is in flight: `SETTLEMENT_TRANSFER` (Dr UNSETTLED / Cr `platform:SETTLEMENT_CLEARING`) at creation, then `SETTLEMENT_PAID` (Dr SETTLEMENT_CLEARING / Cr bank, plus the SETTLED memo pair) with the UTR, or `SETTLEMENT_RETURN` (Dr SETTLEMENT_CLEARING / Cr UNSETTLED) if the transfer fails. See [SETTLEMENT.md](./SETTLEMENT.md).

Release from hold (PENDING → UNSETTLED) is a two-line journal, `HOLD_RELEASE`.

### 4.4 Refund: `REFUND`, key `refund:<rfnd>`

₹400 partial refund. By default the original fee is **not** returned; this is configurable per pricing plan. The refund draws from UNSETTLED if the payment is not yet settled, otherwise from AVAILABLE. If the source bucket is insufficient, the refund is rejected (`INSUFFICIENT_BALANCE`) and never pushes the account negative.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:UNSETTLED` *or* `AVAILABLE` | 400.00 |
| Cr | `platform:provider:<prv>:CLEARING` | 400.00 |

If the refund fails at the provider: `REFUND_REVERSAL` posts the exact mirror.

### 4.5 Chargeback: `CHARGEBACK_LIEN` then `CHARGEBACK_DEBIT` or `CHARGEBACK_RELEASE`

**Dispute opened:** freeze ₹1,000.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:AVAILABLE` | 1,000.00 |
| Cr | `merchant:<id>:LIEN` | 1,000.00 |

**Dispute lost:** a ₹200 chargeback fee plus 18 % GST (₹36) is recovered from AVAILABLE, or from RECEIVABLE when AVAILABLE is insufficient.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:LIEN` | 1,000.00 |
| Cr | `platform:provider:<prv>:CLEARING` | 1,000.00 |
| Dr | `merchant:<id>:AVAILABLE` *or* `merchant:<id>:RECEIVABLE` | 236.00 |
| Cr | `platform:FEE_REVENUE` | 200.00 |
| Cr | `platform:GST_PAYABLE` | 36.00 |

**Dispute won:** Dr `LIEN` 1,000 / Cr the buckets the lien came from (`AVAILABLE`, `UNSETTLED`, or `RECEIVABLE` for any part the merchant couldn't cover), as recorded on the dispute. Workflow: docs/DISPUTES.md.

If AVAILABLE is short when the dispute opens, the shortfall is lien-ed from UNSETTLED. If both are short, the remainder goes to `RECEIVABLE` and a `HOLD_SETTLEMENT` risk action is raised.

### 4.6 Payout reserve: `PAYOUT_RESERVE`, key `payout:<pout>:reserve`

This uses your example: a ₹10,000 payout with a ₹5 fee (GST-exclusive shown first). It is posted **in the payout-creation transaction**, after `FOR UPDATE` on AVAILABLE confirms `balance ≥ 10,005`.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:AVAILABLE` | 10,005.00 |
| Cr | `merchant:<id>:RESERVED` | 10,005.00 |

### 4.7 Payout success: `PAYOUT_SETTLE`, key `payout:<pout>:settle`

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:RESERVED` | 10,005.00 |
| Cr | `platform:provider:<prv>:CLEARING` | 10,000.00 |
| Cr | `platform:FEE_REVENUE` | 5.00 |

Read together with 4.6, this is exactly the requirement: **merchant debited ₹10,005, clearing credited ₹10,000, fee credited ₹5.**

**With GST configured** (18 % on ₹5 = ₹0.90), the reserve becomes ₹10,005.90 and the settle journal becomes:

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:RESERVED` | 10,005.90 |
| Cr | `platform:provider:<prv>:CLEARING` | 10,000.00 |
| Cr | `platform:FEE_REVENUE` | 5.00 |
| Cr | `platform:GST_PAYABLE` | 0.90 |

Provider charges on the payout (e.g. ₹3) are recognised when the provider bills or deducts them: Dr `PROVIDER_COST` 3 / Cr `provider:<prv>:CLEARING` 3.

### 4.8 Payout failure: `PAYOUT_RELEASE`, key `payout:<pout>:release`

A definitive failure before money left the bank. By default the full amount, fee included, is released.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `merchant:<id>:RESERVED` | 10,005.90 |
| Cr | `merchant:<id>:AVAILABLE` | 10,005.90 |

### 4.9 Payout reversal after success: `PAYOUT_REVERSAL`, key `payout:<pout>:reversal`

The beneficiary bank returns the funds days later. The principal is credited back. Fee and GST are **retained by default**. If policy refunds them, the extra lines below are added, and finance must issue a GST credit note, so this policy needs finance and tax sign-off.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `platform:provider:<prv>:CLEARING` | 10,000.00 |
| Cr | `merchant:<id>:AVAILABLE` | 10,000.00 |
| *Dr* | *`platform:FEE_REVENUE`* | *5.00* |
| *Dr* | *`platform:GST_PAYABLE`* | *0.90* |
| *Cr* | *`merchant:<id>:AVAILABLE`* | *5.90* |

### 4.10 Manual adjustment: `ADJUSTMENT_CREDIT` / `ADJUSTMENT_DEBIT`, key `adjustment:<adj>`

The adjustment is posted only once the `Adjustment` record reaches `APPROVED` (maker ≠ checker when configured). The journal stores `created_by_id`, `metadata.reason`, `metadata.reference` and `metadata.approved_by`, and an audit log row is written in the same transaction.

| Dr/Cr | Credit ₹250 | Dr/Cr | Debit ₹250 |
| --- | --- | --- | --- |
| Dr | `platform:ADJUSTMENT_SUSPENSE` 250 | Dr | `merchant:<id>:AVAILABLE` 250 |
| Cr | `merchant:<id>:AVAILABLE` 250 | Cr | `platform:ADJUSTMENT_SUSPENSE` 250 |

A debit adjustment obeys `allow_negative = false`. If it exceeds AVAILABLE it is rejected, or it is explicitly routed to `RECEIVABLE` by a checker with the separate permission `ledger.adjust_receivable`. Finance later clears suspense against the real source (Dr/Cr `PROVIDER_COST`, `FEE_REVENUE`, bank, …) with its own journal.

### 4.11 Lien placement and release: `LIEN_PLACE` / `LIEN_RELEASE`

| Dr/Cr | Place ₹5,000 | Dr/Cr | Release ₹5,000 |
| --- | --- | --- | --- |
| Dr | `merchant:<id>:AVAILABLE` | Dr | `merchant:<id>:LIEN` |
| Cr | `merchant:<id>:LIEN` | Cr | `merchant:<id>:AVAILABLE` |

### 4.12 Reseller commission accrual: `COMMISSION_ACCRUAL`, key `commission:<txn_id>`

Async through the `ledger.post` topic, since it is not spendable by the merchant. On the ₹1,000 payin: merchant fee 0.18 % = ₹1.80, and Pay2All charges the reseller 0.14 % = ₹1.40, so the reseller margin is ₹0.40. Amounts come from the transaction's pricing snapshot, never recomputed.

| Dr/Cr | Account | Amount |
| --- | --- | --- |
| Dr | `platform:COMMISSION_EXPENSE` | 0.40 |
| Cr | `reseller:<id>:COMMISSION_PAYABLE` | 0.40 |

GST treatment of reseller commission (reverse charge vs. invoice) is a finance decision. Additional lines can be added without changing the model.

## 5. Balance service

```ts
interface MerchantBalances {
  currency: CurrencyCode;
  available: bigint; pending: bigint; unsettled: bigint;
  reserved: bigint;  lien: bigint;    settledToDate: bigint;
  asOf: Date;
}
getBalances(merchantId: string, currency?: CurrencyCode): Promise<MerchantBalances>
```

- **Source of truth:** `ledger_entries`. **Read model:** `ledger_accounts.balance_minor`, maintained for merchant and reseller accounts. It is updated **in the same transaction** that inserts the entries:
  `UPDATE ledger_accounts SET balance_minor = balance_minor + $delta, version = version + 1 WHERE id = $id RETURNING balance_minor`.
  The returned value is written to `ledger_entries.balance_after_minor`, giving every statement line a running balance.
- **Reads take no locks.** They see the last committed state under READ COMMITTED. Dashboard reads may be cached in Redis for ≤ 2 s, but **never** for payout or refund decisions.
- **Writes take locks** (§6). The authoritative available-balance check happens inside the posting transaction on the locked row, never on a cached or pre-read value.
- **Verification job** (hourly, plus on demand): for each maintained account, `Σ entries` must equal `balance_minor`. The latest `balance_after_minor` must also equal `balance_minor`. Any drift raises a P1 alert and freezes payouts for the merchant (`DISABLE_PAYOUT` risk action). It never silently "fixes" anything.
- **`BalanceSnapshot`:** a daily closing balance per account at 00:00 IST, used for statements, recon and fast historical balances (`snapshot + Σ entries since`). Platform accounts without a maintained balance are reported from snapshots and entries.

## 6. Concurrency and hot accounts

- **Isolation:** READ COMMITTED with explicit row locks. SERIALIZABLE is not used, because the abort rate under load is unpredictable while explicit locks make contention visible and bounded.
- **Lock set:** a posting locks only the **maintained** accounts it touches, with `SELECT id, balance_minor FROM ledger_accounts WHERE id = ANY($ids) ORDER BY id FOR UPDATE`. **Sorting by id** gives a global lock order, so two transactions can never deadlock on ledger accounts.
- **Lock order across tables:** business row (payment/payout, by conditional update) first, then ledger accounts in id order. Every code path follows this order.
- **Non-negative guarantee:** the application checks the locked balance before inserting entries, and `CHECK (allow_negative OR balance_minor >= 0)` is the backstop. A violation (`23514`) maps to `INSUFFICIENT_BALANCE`.
- **Hot platform accounts:** `FEE_REVENUE`, `GST_PAYABLE` and `provider:*:CLEARING` appear in nearly every journal. Locking them would serialize the whole platform to one row, which caps throughput far below 1,000 TPS. They therefore have `balance_minor = NULL` (not maintained): entries are inserted without touching the account row, and balances are aggregated from entries and snapshots. If a platform-level running balance is ever needed, the account is split into **N sharded sub-accounts** (`platform:FEE_REVENUE#00..#15`, picked by `hash(journal_id) % N`) and summed for reporting.
- **Contention is per merchant**, which is inherent. One merchant's concurrent payouts serialize on its AVAILABLE row. The lock is held for the short posting transaction only (target < 10 ms), and **never across a provider call**.
- **Retries:** deadlock (`40P01`), serialization failure (`40001`) and lock timeout (`55P03`) are retried with jittered backoff, max 3 attempts, and **only for whole transactions that carry a journal idempotency key**. A retry can never double-post: the second attempt finds the key and returns the original journal. `SET LOCAL lock_timeout = '2s'` bounds waits.

## 7. Posting service API (`packages/ledger`)

```ts
type Direction = 'DEBIT' | 'CREDIT';

interface PostingLine {
  accountCode: string;            // resolved/created idempotently, e.g. 'merchant:org_01J…:AVAILABLE'
  direction: Direction;
  amount: Money;                  // > 0
  memo?: string;
}

interface PostJournalInput {
  type: JournalType;              // PAYIN_CAPTURE | PAYOUT_RESERVE | PAYOUT_SETTLE | …
  idempotencyKey: string;         // deterministic: '<source>:<id>:<step>'
  source: { type: SourceType; id: string };   // e.g. { type: 'PAYOUT', id: 'pout_01J…' }
  lines: PostingLine[];
  effectiveAt?: Date;             // business date; postedAt is always now()
  metadata?: Record<string, string>;
  actor: { userId?: string; requestId: string };
}

interface PostedJournal {
  journalId: string;              // 'jrnl_…'
  replayed: boolean;              // true when idempotencyKey already existed
  entries: { entryId: string; accountId: string; balanceAfter?: bigint }[];
}

// Must be called with the caller's Prisma transaction client (ADR-5).
postJournal(tx: TxClient, input: PostJournalInput): Promise<PostedJournal>;
reverseJournal(tx: TxClient, journalId: string, input: {
  idempotencyKey: string; reason: string; actor: PostJournalInput['actor'];
}): Promise<PostedJournal>;
```

`postJournal` performs these steps in order:

1. **Validate shape.** There must be at least 2 lines, every `amount > 0`, every line in a known currency, Σ Dr = Σ Cr per currency, and the `type` must permit the given account buckets. For example, `PAYOUT_RESERVE` may only move AVAILABLE → RESERVED for the same merchant. Failures throw `LedgerValidationError` before any I/O.
2. **Idempotency.** Look up `ledger_journals.idempotency_key`. If it exists, compare a canonical hash of `(type, source, lines)` with the stored `lines_hash`. If they are identical, return `{ replayed: true }`. If they differ, throw `LedgerIdempotencyConflict`, because that is a bug, never a retry. A concurrent insert race is resolved by the unique index (`23505`), and the loser re-reads and applies the same comparison.
3. **Resolve accounts.** Fetch accounts by code and create missing ones (`INSERT … ON CONFLICT (code) DO NOTHING`).
4. **Lock** the maintained accounts in id order (`FOR UPDATE`).
5. **Check** that every non-negative account still satisfies `balance + delta ≥ 0`. Otherwise throw `InsufficientBalanceError` with the account bucket.
6. **Insert** the journal, then the entries in one multi-row insert, then update maintained balances and record `balance_after_minor`.
7. The deferred trigger re-asserts balance at COMMIT.

The service never commits. The caller owns the transaction, which is how the business row, the journal and the outbox event commit atomically.

`reverseJournal` loads the original journal, refuses if it is already reversed (unique `reverses_journal_id`) or is itself a reversal of a reversal without explicit permission, then posts a mirrored journal with `type = REVERSAL`, every direction swapped, and identical amounts. It is subject to the same non-negative checks, so reversing a payin credit the merchant has already spent fails loudly instead of creating a negative balance.

## 8. Reversals, adjustments and period close

- **Reversal** is used when the original posting was *wrong*. **Business-level counter-events** use their own journal type when the original posting was right and something new happened: refund, chargeback, payout reversal after success. Reports can then tell "we made a mistake" apart from "money moved back".
- **Adjustments** follow the `Adjustment` workflow `DRAFT → PENDING_APPROVAL → APPROVED → POSTED` (or `REJECTED`). Approval needs `ledger.adjust.approve`, and the checker cannot be the maker when maker-checker is on. Each step writes an `AuditLog` row. The journal is posted only at `POSTED`, with key `adjustment:<adj>`.
- **Period close:** the daily `BalanceSnapshot` is taken at 00:00 IST. Postings are never back-dated into a closed period. `effective_at` may record the business date, but `posted_at` is always the true insert time, and late items surface in the next period with a reference.
- **Reconciliation hooks:** provider clearing balance vs. the provider report; bank account balance vs. the bank statement; Σ UNSETTLED vs. settlement due; `platform:SUSPENSE` and `ADJUSTMENT_SUSPENSE` must trend to zero. Mismatches create `ReconciliationEntry` rows (DATABASE.md §2.6), never automatic postings.

## 9. Invariants and the tests that prove them

Invariants that hold at all times (asserted in tests and by the verification job):

1. Every journal balances per currency.
2. No posted journal or entry is ever updated or deleted.
3. `ledger_accounts.balance_minor = Σ entries` for every maintained account.
4. No account with `allow_negative = false` is ever below zero.
5. One idempotency key produces exactly one journal.
6. Σ over all accounts of (debits − credits) = 0, i.e. the trial balance is zero.

| Test (from the platform requirements) | Asserts |
| --- | --- |
| Double ledger balancing | Unbalanced lines are rejected in the app. A raw SQL unbalanced insert fails at COMMIT (trigger). Trial balance is zero after a fixture run. |
| Ledger immutability | `UPDATE` and `DELETE` on `ledger_entries` and `ledger_journals` raise. |
| Idempotency | `postJournal` twice with the same key gives one journal and `replayed = true`. The same key with different lines throws a conflict. Two parallel posts with one key give one journal. |
| Concurrent payout | N parallel ₹X reserves against a ₹(k·X) balance: exactly k succeed, the rest get `INSUFFICIENT_BALANCE`, and the balance ends ≥ 0 and equals Σ entries. |
| Insufficient balance | A reserve above AVAILABLE is rejected with no partial rows. |
| Duplicate payout | Retrying a payout with the same idempotency key yields one reserve journal. |
| Provider failure | Definitive failure gives a release journal and AVAILABLE restored exactly. An ambiguous timeout gives no release while the payout stays PENDING. |
| Payout reversal | Success then reversal: AVAILABLE is credited by the principal and the fee is retained by default. |
| Refund | Partial refunds summing to the payment amount succeed; one more paise is rejected. Concurrent refunds never exceed the payment. |
| Reversal journal | `reverseJournal` mirrors exactly, a second reversal is refused, and reversing spent funds fails with insufficient balance. |
| Balance verification | A deliberately corrupted `balance_minor` (test-only, trigger disabled in the fixture) is detected by the verification job. |

## 10. Implementation notes (Phase 3)

| Concern | Where it lives |
| --- | --- |
| Money helpers (`parseMajorToMinor`, `percentOf`, `taxOn`, `clamp`, `parseRateMicros`) | `@pay2all/ledger` (browser-safe root export) |
| Posting engine: chart of accounts, journal-type rules, validation, lines hash, `postJournal`, `reverseJournal` | `@pay2all/ledger/engine` (Node-only subpath). It is pure and talks to storage through the `LedgerStore` port. |
| Prisma `LedgerStore`: sorted `FOR UPDATE`, `ON CONFLICT DO NOTHING` journal insert, balance updates | `apps/api/src/modules/ledger/prisma-ledger-store.ts` |
| Transaction runner (READ COMMITTED, `lock_timeout = 2s`, jittered retry on `40P01/40001/55P03`) | `apps/api/src/modules/ledger/ledger-transaction.ts` |
| DB guards: immutability, deferred balance check, entry/account currency match, account identity immutable, non-negative CHECK, one reversal per journal | migration `…_ledger` |
| Shared SQL: `ledger_account_balances(cutoff)`, `ledger_verify_balances()` | migration `…_ledger`. The API (`POST /v1/ledger/verify`) and the worker (hourly) run the same SQL. |
| Daily snapshots at 00:00 IST, drift detection that freezes payouts | `apps/worker/src/jobs/ledger-jobs.ts`. A Redis-claimed scheduler ensures one run per key across replicas. |

**Decisions made during implementation:**

- **Posting code lives in the API.** The Prisma store sits in the API because a store inside `packages/ledger` would form a workspace dependency cycle (`ledger → database → validation → ledger`). The worker gets its own store when Phase 7 needs to post.
- **Platform permission.** `ledger.platform.read` is a PLATFORM-only permission for platform-wide totals, accounts and integrity checks. Merchants see only their own accounts, and only their own lines of any journal.
- **Adjustment approval policy.** Adjustments use the approval-policy table with `service = ADJUSTMENT`, seeded at the SYSTEM level as one approver for every amount. With no policy at all the default is one approver, so the system fails safe.
- **Atomic approval.** Approval and posting happen in one transaction. A debit adjustment that would overdraw rolls back the approval itself, and the adjustment stays pending.
- **Reversal idempotency.** Reversal journals use the key `reversal:<journal_id>`, so a repeated request returns the same reversal.
- **Zero-amount lines are invalid.** Callers omit zero fee or GST lines; for example, a tiny payment whose fee rounds to zero simply has no fee line.
- **Demo history goes through the engine.** `pnpm db:seed` posts the demo history through the real engine (`apps/api/scripts/seed-demo-ledger.ts`), including the spec payout example. The seed is idempotent.

**Verified by tests:**

- **Unit:** 300 randomized postings keep a zero trial balance, and stored balances always equal Σ entries.
- **Integration:**
  - 15 concurrent ₹100 reserves against ₹500 → exactly 5 succeed.
  - Raw SQL cannot commit an unbalanced journal.
  - Entries and journals are immutable.
  - A corrupted balance is detected and freezes payouts.
- **Mutation check:** removing `FOR UPDATE` makes all 15 reserves succeed (a double spend), and the test fails as intended.
