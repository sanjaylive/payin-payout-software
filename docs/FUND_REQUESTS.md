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
- **UTR uniqueness:** a UTR can be claimed by **one pending or approved request** across all merchants, enforced by a partial unique index. A rejected or cancelled claim frees it again.
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
  3. The approver may credit **less** than requested, with a note (for example when the statement shows less), but never more.
- **Reject:** needs a reason, which the merchant sees.
- **Audit:** every step is audited (`funds.*`); approvals are marked HIGH severity.

## 4. Add / deduct balance

**Add / deduct balance** on the Fund Requests page credits or debits any approved merchant's AVAILABLE balance, with a reference and a reason of at least 10 characters.

- **How it is applied:** it uses the existing ledger adjustment flow (docs/LEDGER.md §4.10), so it is balanced against the adjustment suspense account.
- **Approval:** amounts within the **ADJUSTMENT approval policy's** no-approval tier are posted at once. Larger amounts wait for an independent approver under **Ledger → Adjustments**, and the dialog says which happened.
- **Overdraw protection:** a deduction can never overdraw the balance; the ledger refuses it.

## 5. API

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

## 6. Not yet included

- **Statement matching:** bank statements are not yet matched to fund requests automatically. Reconciliation is still a person comparing the UTR.
- **Payment gateway top-ups:** instant top-ups through a payment gateway are not supported.
