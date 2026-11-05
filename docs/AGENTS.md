# Agents (customer service points)

An **agent** is a shop that serves walk-in customers: money transfers (DMT-style), cash withdrawal (AEPS / micro-ATM), cash deposit, bill payments and recharges. The agent does the real transaction somewhere else, such as a bank CSP portal or their UPI app. Pay2All is the agent's **counter register**. It keeps customers and beneficiaries, records every transaction with a receipt, shows the day's cash position, and provides reports, backups and staff logins.

> **Nothing here moves money.** Agent records never touch the ledger (docs/LEDGER.md), payouts or settlements. Real DMT through Pay2All payouts would be a separate, licensed product.

Agents are their own organization type, `AGENT`. They sign up themselves, with no KYB, and use either the web counter at `/agent` or the Flutter app (`apps/mobile`).

## 1. Accounts and roles

- **Sign-up** reuses the email-code sign-up (docs/ONBOARDING.md §1) with `account_type: "AGENT"`. `business_name` is the shop name. Verifying the code creates:
  - an `AGENT` organization;
  - its `agent_profiles` row on the **Free** plan;
  - the owner's login with the role **AGENT_OWNER**.
  
  The owner is signed in straight away. A referral code or partner domain sets the parent organization, as it does for merchants.
- **Roles** (packages/auth/src/roles.ts). Two-factor is **optional** for both; owners can turn it on under Security.

  | Role | Permissions |
  | --- | --- |
  | AGENT_OWNER | `agent.desk.read`, `agent.desk.write`, `agent.txn.manage`, `agent.settings.manage`, `agent.billing.manage` |
  | AGENT_OPERATOR (counter staff) | `agent.desk.read`, `agent.desk.write` |

- **Platform staff** use `agent.admin.read` and `agent.admin.manage`. SUPER_ADMIN and ADMIN have both.
- **Tenancy:** every `/v1/agent/*` query filters on the signed-in agent's organization. Another agent's ids answer 404.

## 2. Plans

| | Free | Starter | Business |
| --- | --- | --- | --- |
| Price (default, editable) | ₹0 | ₹199/month, ₹1,999/year | ₹499/month, ₹4,999/year |
| Transactions per month (IST) | 100 | 2,000 | Unlimited |
| Logins (owner included) | 1 | 3 | 10 |
| Google Drive backup | – | ✓ | ✓ |
| Branded receipts (logo, footer, no platform name) | – | ✓ | ✓ |
| SMS / WhatsApp receipts | – | – | ✓ |

- Platform admins edit names, prices, limits and features (Admin → Agents → Plans). Plan codes are fixed. Free cannot be switched off or priced.
- A paid plan applies until `plan_expires_at`. After that the agent is on Free again: nothing is deleted, but Free's limits apply again.
- **Limit enforcement:**
  - Recording a transaction locks the agent's profile row, which also hands out the next receipt number. So concurrent entries cannot overrun the monthly allowance.
  - Over the limit, the API answers `LIMIT_EXCEEDED` (HTTP 422) with an upgrade message.
  - The staff limit is checked when a login is created or re-enabled.

### 2.2 Paying for a plan

1. A super admin picks the **billing merchant** (Admin → Agents → Settings). This is one of the platform's own approved merchants with collections on.
2. The agent chooses a plan and period. `POST /v1/agent/billing/checkout` creates:
   - an **order**;
   - a **payment link** (checkout session of kind `LINK`) on the billing merchant, valid 24 h.
   
   The agent pays on the hosted checkout with the platform's gateways.
3. The jobs process (`agent-plan-orders`, every 60 s) marks the order paid once the link is paid. `GET /v1/agent/billing/orders/:id` checks immediately too.
   - Paying for the **same** plan extends it from its current end.
   - A **different** plan starts now.
4. Admins can **grant** a plan until a date (or reset to Free) without payment. The grant is recorded as an order with `granted: true`.

The money lands on the billing merchant's balance like any other payment and is settled in the normal way.

## 3. Counter

- **Customer:**
  - Fields: name, mobile (unique per agent), email, address, date of birth, ID document.
  - The ID number is stored **encrypted** (FieldEncryptor); lists show the last 4.
  - `GET …/id-number` reveals the full number and is audited.
- **Beneficiary:**
  - Belongs to one customer: a bank account (number encrypted; IFSC required with it) and/or a UPI id.
  - The agent sees the full account number, because they type it into the bank portal.
  - Removing a beneficiary hides it; old receipts keep its details.
- **Transaction:** `type` decides the direction.

  | type | direction | meaning |
  | --- | --- | --- |
  | MONEY_TRANSFER | IN | customer pays cash/UPI; agent sends it to the beneficiary (needs customer + beneficiary) |
  | CASH_WITHDRAWAL | OUT | AEPS / micro-ATM: agent pays cash to the customer |
  | CASH_DEPOSIT | IN | customer's cash into their own account |
  | BILL_PAYMENT, RECHARGE | IN | |
  | OTHER | IN or OUT (required) | |

  - `fee` is the service charge the agent collects.
  - `total` is what the customer pays (IN: amount + fee) or receives (OUT: amount − fee).
  - The counter's **net** for a period is money in − money out + fees.
  - `mode`: CASH, UPI, BANK or OTHER (how the customer paid or was paid).
  - `status`: SUCCESS or PENDING when recorded. Then PENDING → SUCCESS / FAILED, or SUCCESS → FAILED / REFUNDED (owner only, `agent.txn.manage`, audited). FAILED and REFUNDED are final and are left out of totals.
  - Customer and beneficiary details are **copied** onto the transaction, so a receipt never changes later.
  - Receipt numbers are `R-000001`, `R-000002` … per agent.
  - Entries can be back-dated by up to 30 days (`occurred_at`), never into the future.
  - Send an `Idempotency-Key` header (8–64 characters of `[A-Za-z0-9_-]`) with every `POST /v1/agent/transactions`. A retry with the same key within 24 h returns the first transaction instead of recording it twice.

## 4. Receipts and QR

- `GET /v1/agent/transactions/:id/receipt` returns everything a receipt shows (below).
  - **Web:** prints it as HTML (Print / Save as PDF).
  - **Flutter app:** renders a PDF and shares it.
- Every transaction has a random `receipt_token`. The public page `https://<web>/r/<token>` shows the receipt to the customer with no sign-in (`GET /v1/public/agent-receipts/:token`). The page shows nothing else about the agent.
- **Branded receipts** (Starter and Business) show the shop logo and footer and no platform name. Free receipts say "Powered by \<platform\>".
- **SMS / WhatsApp** (Business): `POST …/send-receipt` queues the link through the platform's messaging vendors (template `agent_receipt`, variables `shop`, `receipt_no`, `amount`, `type`, `link`; India SMS needs that DLT template approved). Limited to 60 sends per agent per hour.
- **Free "Share" button:** the apps also offer a free WhatsApp share (`https://wa.me/?text=…` with the link). That needs no plan, because the agent's own phone sends it.
- **QR:**
  - The agent saves their **UPI id** (and payee name). The apps draw `upi://pay?pa=<vpa>&pn=<name>[&am=<amount>&tn=<note>]` as a QR, with an optional amount for one transaction.
  - The agent may also upload their bank's QR image (`POST /v1/agent/profile/qr`), which the apps show as-is.

## 5. Reports

- `GET /v1/agent/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`: IST dates, at most 366 days. It returns totals plus breakdowns by day, type, mode and status.
- `GET /v1/agent/reports/export?from&to`: the transactions as CSV (UTF-8 with BOM, formula-safe, at most 50,000 rows).

## 6. Staff

The owner creates counter-operator logins with name, email, mobile and a starting password, which must meet the password policy. Operators sign in like anyone else, on the web or the app. Disabling a login signs it out everywhere. Only logins created here (belonging to this agent only) can be changed.

## 7. Google Drive backup

- **Setup:** set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (Google Cloud → APIs & Services → Credentials → OAuth client, type *Web application*).
  - Authorised redirect URI: `<API_PUBLIC_URL>/v1/public/agent-drive/callback`.
  - Enable the **Google Drive API**.
  - Scopes: `drive.file` (the app sees only files it created), `openid`, `email`.
- **Flow:**
  1. `POST /v1/agent/drive/connect` returns a Google URL; open it in a browser. The `state` is single-use, lasts 10 minutes, and is held in Redis.
  2. Google redirects to the callback, which stores the **encrypted** refresh token.
  3. The browser is sent to `<WEB>/agent/backup?drive=connected|error`.
- **What is written** into a folder "\<shop\> — backup":
  - `transactions-all.csv`
  - `transactions-YYYY-MM.csv` (this month)
  - `customers.csv`
  
  Files are replaced on each run, never duplicated.
- **When:** on connect, on demand (at most 6 times an hour), and daily (jobs `agent-drive-backup` runs hourly and backs up anyone not backed up in 20 h) for plans with Drive backup.
- **Disconnect** revokes the token. Files already in Drive stay.

## 8. API

Every response is `{ "success": true, "data": … }`. Lists add `"meta": { "limit", "has_more", "next_cursor" }`; pass `cursor` for the next page. Errors are `{ "success": false, "error": { "code", "message", "request_id", "details"?: [{ "path", "message" }] } }`.

- **Amounts** are rupee strings with two decimals (`"1500.00"`) in both directions.
- **Dates** are ISO-8601 UTC. Report dates are IST calendar days.

### Auth (also for the Flutter app)

| | |
| --- | --- |
| `POST /v1/signup` | `{ name, business_name, email, mobile, password, accept_terms: true, account_type: "AGENT", referral_code? }` → `{ signup_id, email_masked, expires_in, resend_after }` |
| `POST /v1/signup/resend` | `{ signup_id }` |
| `POST /v1/signup/verify` | `{ signup_id, code }` → session |
| `POST /v1/auth/login` | `{ identifier (email or mobile), password }` → session, or `{ status: "MFA_REQUIRED", mfa_token, mfa_methods }` |
| `POST /v1/auth/mfa/verify` | `{ mfa_token, code }` or `{ mfa_token, recovery_code }` → session |
| `GET /v1/auth/me` | user, organization `{ id, name, type: "AGENT", status }`, roles, `permissions[]` |
| `POST /v1/auth/password/forgot` | `{ identifier }` (emails a reset link) |

**Session** = `{ status: "AUTHENTICATED", access_token, token_type: "Bearer", expires_in }`. The access token lives 15 minutes.

- **Browsers** get the refresh token as an httpOnly cookie (`POST /v1/auth/refresh` with header `X-Pay2All-CSRF: 1`).
- **Native apps** send `X-Pay2All-Client: mobile` on login, `mfa/verify` and `signup/verify`, and receive `refresh_token` in the body. Keep it in the OS keystore.
  - Rotate it with `POST /v1/auth/mobile/refresh { refresh_token }` (same header). Each refresh returns a **new** `refresh_token`; reusing an old one revokes the session.
  - Sign out with `POST /v1/auth/mobile/logout { refresh_token }`.

### Agent (Bearer token; permission in brackets)

| Method & path | Body / query → result |
| --- | --- |
| `GET /v1/agent/dashboard` [desk.read] | → `{ profile, today: { money_in, money_out, fees, net, count }, month: { volume, fees, count }, customers, recent: Transaction[] }` |
| `GET /v1/agent/profile` [desk.read] | → Profile |
| `PATCH /v1/agent/profile` [settings] | `{ shop_name?, owner_name?, address_line?, city?, state?, pincode?, upi_vpa?, upi_payee_name?, receipt_footer? }` → Profile |
| `POST /v1/agent/profile/qr` · `/logo` [settings] | multipart `file` (PNG/JPEG/WebP ≤ 2 MB) → Profile |
| `DELETE /v1/agent/profile/qr` · `/logo` [settings] | → Profile |
| `GET /v1/agent/profile/qr` · `/logo` [desk.read] | → the image |
| `GET /v1/agent/customers?search&cursor&limit` [desk.read] | → Customer[] (paged) |
| `GET /v1/agent/customers/lookup?mobile=` [desk.read] | → `{ customer: CustomerDetail \| null }` |
| `POST /v1/agent/customers` [desk.write] | `{ name, mobile, email?, address_line?, city?, pincode?, date_of_birth? (YYYY-MM-DD), id_type?, id_number?, note? }` → CustomerDetail |
| `GET /v1/agent/customers/:id` [desk.read] | → CustomerDetail |
| `PATCH /v1/agent/customers/:id` [desk.write] | any Customer field → CustomerDetail |
| `GET /v1/agent/customers/:id/id-number` [desk.write] | → `{ id_type, id_number }` (audited) |
| `POST /v1/agent/customers/:id/beneficiaries` [desk.write] | `{ name, bank_name?, account_number?, ifsc?, upi_id?, relation? }` (account or UPI required; IFSC with account) → Beneficiary |
| `DELETE /v1/agent/beneficiaries/:id` [desk.write] | → `{ removed: true }` |
| `GET /v1/agent/transactions?from&to&type&direction&status&customer_id&search&cursor&limit` [desk.read] | → Transaction[] (paged, newest first) |
| `POST /v1/agent/transactions` [desk.write] + `Idempotency-Key` | `{ type, direction? (OTHER only), mode (default CASH), status (SUCCESS\|PENDING, default SUCCESS), amount, fee (default "0"), reference?, description?, customer_id?, beneficiary_id?, customer_name?, customer_mobile?, occurred_at? }` → Transaction |
| `GET /v1/agent/transactions/:id` [desk.read] | → Transaction |
| `POST /v1/agent/transactions/:id/status` [txn.manage] | `{ status, reference?, note? }` → Transaction |
| `GET /v1/agent/transactions/:id/receipt` [desk.read] | → Receipt |
| `POST /v1/agent/transactions/:id/send-receipt` [desk.write] | `{ channel: SMS\|WHATSAPP, mobile? }` → `{ sent, channel }` |
| `GET /v1/agent/reports/summary?from&to` [desk.read] | → Summary |
| `GET /v1/agent/reports/export?from&to` [desk.read] | → CSV file |
| `GET /v1/agent/staff` [settings] | → `{ staff_limit, active, members: [{ user_id, name, email, mobile, role, role_name, active, last_login_at, is_you }] }` |
| `POST /v1/agent/staff` [settings] | `{ name, email, mobile, password }` → same as GET |
| `POST /v1/agent/staff/:userId/status` [settings] | `{ active }` → same as GET |
| `GET /v1/agent/billing` [desk.read] | → `{ current: Plan & { expires_at, lapsed_from }, usage, plans: Plan[], online_payment_available, orders: Order[] }` |
| `POST /v1/agent/billing/checkout` [billing] | `{ plan_code: STARTER\|BUSINESS, period: MONTHLY\|YEARLY }` → Order (open `checkout_url`) |
| `GET /v1/agent/billing/orders/:id` [desk.read] | → Order (re-checks payment) |
| `POST /v1/agent/billing/orders/:id/cancel` [billing] | → Order |
| `GET /v1/agent/drive` [settings] | → `{ available, included_in_plan, connected, google_email, status, auto_backup, last_backup_at, last_error, folder_url }` |
| `POST /v1/agent/drive/connect` [settings] | → `{ url }` |
| `POST /v1/agent/drive/backup` [settings] | → drive status |
| `PUT /v1/agent/drive/settings` [settings] | `{ auto_backup }` → drive status |
| `DELETE /v1/agent/drive` [settings] | → `{ disconnected: true }` |

### Shapes

- **Plan:** `{ code, name, description, price_monthly, price_yearly, monthly_txn_limit (null = unlimited), staff_limit, drive_backup, branded_receipts, messaging, active }`
- **Profile:** `{ id, shop_name, owner_name, email, mobile, address_line, city, state, pincode, upi_vpa, upi_payee_name, has_qr_image, has_logo, receipt_footer, created_at, plan: Plan & { expires_at, lapsed_from }, usage: { transactions_this_month, staff } }`
- **Customer:** `{ id, name, mobile, email, address_line, city, pincode, date_of_birth, id_type, id_number_masked, note, created_at }`. **CustomerDetail** adds `transactions, last_transaction_at, beneficiaries: Beneficiary[]`.
- **Beneficiary:** `{ id, customer_id, name, bank_name, account_number, account_masked, ifsc, upi_id, relation, active, created_at }`
- **Transaction:** `{ id, receipt_no, type, direction, mode, status, amount, fee, total, reference, description, customer: { id, name, mobile } | null, beneficiary: { id, name, bank_name, account_masked, ifsc, upi_id } | null, occurred_at, created_by, status_note, status_changed_at, receipt_sent_at, receipt_token, created_at }`
- **Receipt:** `{ transaction, type_label, shop: { name, mobile, address, upi_vpa, logo_url (API path) | null, footer }, branded, powered_by, public_url }`
- **Summary:** `{ from, to, totals: { money_in, money_out, fees, net, count }, by_type: [{ type, label, direction, amount, fees, count }], by_mode: [{ mode, direction, amount, count }], by_status: [{ status, amount, count }], by_day: [{ date, money_in, money_out, fees, net, count }] }`
- **Order:** `{ id, plan_code, plan_name, period, amount, status: PENDING|PAID|EXPIRED|CANCELLED, checkout_url (while PENDING), period_start, period_end, paid_at, granted, created_at }`

### Public (no sign-in)

- `GET /v1/public/agent-plans` → Plan[]
- `GET /v1/public/agent-receipts/:token` → Receipt (without `receipt_token` and `created_by`)
- `GET /v1/public/agent-receipts/:token/logo`
- `GET /v1/public/agent-drive/callback` (Google's redirect)

### Platform admin

| | |
| --- | --- |
| `GET /v1/admin/agents/overview` | `{ agents, new_this_month, by_plan: [{ code, name, agents }], transactions_this_month, volume_this_month, plan_revenue_this_month, plan_orders_this_month }` |
| `GET /v1/admin/agents?search&plan&cursor&limit` | agents: `plan_code` is the plan in force, `subscribed_plan_code` the one paid for (they differ once it lapses) |
| `GET /v1/admin/agents/:agentId` | detail with orders |
| `POST /v1/admin/agents/:agentId/status` | `{ status: ACTIVE\|SUSPENDED, reason? }`; suspending signs everyone out |
| `POST /v1/admin/agents/:agentId/plan` | `{ plan_code, expires_at? (YYYY-MM-DD), note? }` |
| `GET /v1/admin/agent-plans`, `PATCH /v1/admin/agent-plans/:code` | plan editor: `{ name?, description?, price_monthly?, price_yearly?, monthly_txn_limit? (null = unlimited), staff_limit?, drive_backup?, branded_receipts?, messaging?, active? }` |
| `GET` / `PUT /v1/admin/agent-settings` | PUT `{ billing_merchant_id }` → `{ billing_merchant_id, billing_merchant_name, billing_ready }` |

## 9. Security notes

- **Encryption:** customer ID numbers, beneficiary account numbers and Google refresh tokens are AES-256-GCM encrypted with associated data that binds each value to its row.
- **Audit:** every write (and every ID reveal) goes to the audit log.
- **Public receipt links:** they carry 192-bit random tokens and expose only the receipt.
- **Native refresh tokens:** they are returned only to callers that send `X-Pay2All-Client: mobile`. That header is not in the CORS allow-list, so a page on another site cannot ask for one.
- **Row-level security:** agent tables are not under Postgres RLS. They are not read by the RLS reporting role. Every query filters on the actor's agent id, and the tenancy tests cover it.
