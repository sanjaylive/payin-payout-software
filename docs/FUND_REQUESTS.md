# Wallet funds

Merchants load their **AVAILABLE** balance, which is used for payouts, by paying Pay2All and asking for the payment to be credited. Platform staff can also add to or deduct from any merchant's balance directly.

| Where | Who | What |
| --- | --- | --- |
| **Settings → Fund Accounts** | Super admins (`system.settings.manage`) | Bank accounts and UPI IDs merchants pay into |
| **Accounts → Add Funds** (merchant) | `fund.request` (Owner, Admin, Finance) | Pay by UPI QR or bank transfer, submit the UTR, track requests |
| **Fund Requests** (admin) | `fund.read` to view; `fund.approve` to decide (Super admin, Admin, Finance) | Review queue, proof preview, approve or reject, and direct add / deduct |

## 1. Fund accounts

- **Bank account:**
  - fields: label, account holder, account number, IFSC, bank, branch, current or savings;
  - the account number is **encrypted** (AAD `collection-account:<id>`);
  - the admin screens show only the last 4 digits;
  - merchants see the full number on the Add Funds page, because they need it to transfer.
- **UPI ID:** label, UPI ID and payee name. Merchants get a **QR code** carrying the amount and a note (`upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`), generated in the browser. On phones there is also a button to open a UPI app.
- **Shared options:**
  - optional minimum and maximum amount;
  - instructions shown to merchants;
  - display order;
  - **Show to merchants** on or off.
- **Accounts with requests:**
  - such an account can be switched off but not removed;
  - its bank account number can't be changed while it has pending or approved requests.
- **Ledger:** each account has its own ledger account, `platform:bank:<account id>` (ASSET). It is debited whenever a request paid into that account is approved, so it can be reconciled against that account's statement.

## 2. Merchant flow

1. **Amount and account:** the merchant chooses an amount (with quick picks) and the account to pay into. The account's limits are checked as they type.
2. **Pay:** a UPI account shows the QR with the amount filled in; a bank account shows its details with copy buttons.
3. **Confirm:** the merchant enters:
   - the **UTR / reference**;
   - how they paid (a UPI ID accepts UPI only);
   - when they paid (not in the future, at most 30 days ago);
   - optional remarks;
   - an optional **screenshot or PDF** (PNG, JPEG, WebP or PDF, up to 5 MB, identified by its bytes and stored encrypted).

**Rules:**
- **UTR uniqueness:** a UTR can be submitted **once, for ever**, across all merchants, enforced by a unique index on `fund_requests.utr`.
  - **No reuse:** rejecting or cancelling a request does not free its UTR, so a UTR can never be credited twice.
  - **Normalisation:** UTRs are upper-cased and spaces and dashes are removed before the check, so `hdfc-1234 5678` and `HDFC12345678` are the same UTR.
  - **Messages:** a merchant re-entering its own UTR is told when it was submitted and what happened to it. Another merchant learns only that the UTR has been used.
  - **Concurrency:** concurrent submissions of one UTR create exactly one request.
- **Who can request:** only approved merchants can request.
- **Pending cap:** at most 20 requests can be pending per merchant.
- **Cancelling:** merchants can cancel their own pending requests.
- **Tenancy:** the merchant always comes from the session, never from the request body.

## 3. Review

- **Notifications:** approvers (`fund.approve`) get a bell notification for each new request, and merchants get one when it is decided.
- **Review panel:** the queue opens a side panel with:
  - the amount, UTR (with copy), account, payment time and remarks;
  - a preview of the proof, which is fetched with the reviewer's session and served with a sandboxing CSP; each view is audited.
- **Approve:**
  1. The request is claimed with an optimistic version check, so concurrent approvals credit **exactly once**.
  2. A `FUND_LOAD` journal is posted with idempotency key `fund_request:<id>:load`: **Dr** `platform:bank:<account>`, **Cr** `merchant:<id>:AVAILABLE`.
  3. The approver may credit a **different amount** than requested, with a required note: less when the statement shows less, or more when the merchant typed too little. A UTR can't be submitted again, so a wrong claim is corrected here. Crediting more than requested shows a warning first.
- **Reject:** needs a reason, which the merchant sees.
- **Audit:** every step is audited (`funds.*`); approvals are marked HIGH severity.

## 4. Add / deduct balance

**Add / deduct balance** on the Fund Requests page credits or debits any approved merchant's AVAILABLE balance, with a reference and a reason of at least 10 characters.

- **How it is applied:** it uses the existing ledger adjustment flow (docs/LEDGER.md §4.10), so it is balanced against the adjustment suspense account.
- **Approval:** amounts within the **ADJUSTMENT approval policy's** no-approval tier are posted at once. Larger amounts wait for an independent approver under **Ledger → Adjustments**, and the dialog says which happened.
- **Overdraw protection:** a deduction can never overdraw the balance; the ledger refuses it.

## 5. Choosing a merchant

Merchant pickers search as you type, by name, legal name, PAN or exact ID, through `GET /v1/merchants?search=`, 20 results at a time. They work for any number of merchants. This applies to:
- add / deduct balance;
- the fund request merchant filter;
- ledger adjustments;
- settlement schedules and holds;
- routing rules and the routing simulator;
- pricing rate-card assignment and the fee calculator;
- reseller rate cards.

## 6. API

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/funds/accounts` | `fund.read` | Platform: every account with usage. Merchant: active accounts, with the full number |
| `POST /v1/funds/accounts` / `PUT /v1/funds/accounts/:id` | `system.settings.manage` | `{ kind: BANK \| UPI, … , reason }`. On edit, omit `account_number` to keep it |
| `POST /v1/funds/accounts/:id/remove` | `system.settings.manage` | Only when the account has never had requests |
| `POST /v1/funds/requests` | `fund.request` | `{ collection_account_id, amount, mode, utr, paid_at, remarks? }` |
| `POST /v1/funds/requests/:id/proof` | `fund.request` | multipart `file` |
| `GET /v1/funds/requests/:id/proof` | `fund.read` | The proof, audited |
| `POST /v1/funds/requests/:id/cancel` | `fund.request` | Own pending requests only |
| `POST /v1/funds/requests/:id/decision` | `fund.approve` | `{ decision: APPROVE, credited_amount?, note? }` or `{ decision: REJECT, note }` |
| `GET /v1/funds/requests` · `GET /v1/funds/summary` | `fund.read` | Merchant: own requests. Platform: all, filtered by `status`, `merchant_id` or `q` (UTR or id) |

## 7. Bank statement matching

Admin → Fund requests → **Bank statements** (`fund.approve`, with step-up):

1. Choose the bank fund account and upload its statement as CSV (≤ 5 MB) with `POST /v1/funds/statements/:accountId`. The parser (`packages/validation/src/bank-statement.ts`) finds the header row below any summary rows. It reads common Indian bank column names (date / value date, narration, reference, deposit / credit, or one amount column with a CR/DR flag), takes exact paise amounts, and keeps credits only.
2. **References:** for each credit, the reference column and the narration give UTR/RRN candidates (10–22 letters and digits with at least 6 digits; IFSC codes excluded).
3. **Outcomes:**

   | Status | When | What happens |
   | --- | --- | --- |
   | `MATCHED` | A **pending** request on the **same account** has one of the candidates as its UTR, for **exactly** the credited amount | The request is approved through the normal approval path (claim → FUND_LOAD journal → audit `funds.request.auto_approved` → merchant notified), under the uploader's name; the line records the request (same transaction) |
   | `AMOUNT_MISMATCH` | The UTR matches but the amount differs | Nothing is credited; approve (with the corrected amount and a note) or reject by hand |
   | `ALREADY_DECIDED` | The request was approved/rejected/cancelled before | Informational |
   | `UNMATCHED` | No request with that UTR yet | Kept. When a merchant later submits that UTR for exactly that amount on that account, the request is approved immediately (decided by the system, audit `funds.request.auto_approved`) |

4. **Never twice:**
   - A file can't be imported twice for an account (SHA-256).
   - A UTR can back at most one statement line per account (unique index), so overlapping statements report the repeat as a duplicate and credit nothing.
   - A line can back at most one fund request.
5. **Evidence:** statement lines are append-only (trigger). The only allowed change is `UNMATCHED → MATCHED` when a later request matches.

`GET /v1/funds/statements` lists recent imports; `GET /v1/funds/statements/:id` shows every credit with its result and request.

## 8. Not yet included

- **Payment gateway top-ups:** instant top-ups through a payment gateway are not supported.
