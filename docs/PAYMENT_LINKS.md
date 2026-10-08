# Payment links and payment pages

Both reuse hosted checkout (docs/CHECKOUT.md): a checkout session with a `kind`.

| Kind | Created by | Paid | Ends on |
| --- | --- | --- | --- |
| `CHECKOUT` | Merchant server, for an order on its website | Once | The merchant's `return_url` (approved website) |
| `LINK` | Merchant (dashboard or API), for one customer | Once | A receipt on the checkout page |
| `PAGE` | A payer on a public payment page | Once per payer | A receipt with the page's thank-you message |

A DB CHECK enforces the shape: only `CHECKOUT` has `return_url` + `website_id`; only `PAGE` has `page_id`.

## 1. Payment links

- **Create:** `POST /v1/payment-links` (dashboard or API key with `payin.create`; `Idempotency-Key` required). Body: `amount`, `description`, optional `reference` (unique per merchant; generated `PL-<ULID>` otherwise), `customer`, `expires_in_days` (1–90, default 7), `notify {email, sms}`, `metadata`.
- **Read:** `GET /v1/payment-links`, `GET /v1/payment-links/:id`, `GET /v1/payment-links/summary` (30-day totals, dashboard).
- **Send:** `POST /v1/payment-links/:id/notify {email, sms}` queues an email and/or SMS through the notification worker (vendor routing as in docs/VENDORS.md). Once a minute per link. Creating with `notify` sends after the idempotent create, so a replayed request never sends twice; a failed send leaves the link usable.
  - SMS uses template key `payment_link` with variables `merchant`, `amount`, `url`; live Indian SMS needs that DLT template mapped in the SMS service.
  - WhatsApp sharing in the dashboard is click-to-chat (`wa.me`), opened by the merchant; the platform sends nothing.
- **Cancel:** `POST /v1/payment-links/:id/cancel` (only open, unpaid links).
- **Payer side:** the link URL is the hosted checkout (`/checkout/<token>`). There is no cancel button and no redirect; after payment the page shows a printable receipt (amount, reference, UTR, date).
- **Audit:** `payment_link.created`, `.sent`, `.cancelled`.

## 2. Payment pages

- A reusable public page at `WEB_PUBLIC_URL/p/<slug>` for fees, donations, events or products. Slug: 3–60 of `a-z 0-9 -`, globally unique, some words reserved (`admin`, `api`, `pay`, …).
- **Amount:** `FIXED` (everyone pays `amount`) or `CUSTOMER` (payer enters an amount within `min_amount`–`max_amount`). For a fixed page any amount the browser sends is ignored.
- **Fields:** name, email and mobile are always collected; up to 5 extra fields (`text`, `number`, `email`, `phone`, optionally required). Answers are validated server-side and stored in the session's metadata as `f_<key>`; they appear in the page's payment list and CSV download.
- **Merchant API (dashboard):** `GET/POST /v1/payment-pages`, `GET/PUT /v1/payment-pages/:id`, `POST /v1/payment-pages/:id/status {ACTIVE|INACTIVE}`, `GET /v1/payment-pages/:id/payments`.
- **Public API (rate-limited per IP):** `GET /v1/public/pages/:slug` (title, description, amount, fields, merchant display name only), `POST /v1/public/pages/:slug/checkout {amount?, customer, fields}` → `{token, url}`: a 30-minute `PAGE` session with reference `PG-<ULID>`.
- A page answers 404 when it is inactive, or its merchant is not approved for collections or is suspended.

## 3. Security notes

- Tokens are 24 random bytes; ids never appear in public URLs.
- Amounts always come from the stored link or page (or a range-checked payer amount), never from the payment page's form.
- Outcomes come from the provider as for any payment; the receipt shows only after the session is `PAID`.

## 4. Known limits

- No partial payments or instalments on a link; one link is paid once.
- No reminders on a schedule yet (send again manually).
- Page payers can't download a PDF receipt; the page prints cleanly.
