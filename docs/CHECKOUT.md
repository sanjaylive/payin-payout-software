# Hosted checkout

A merchant creates a **checkout session** for an order and sends the customer to its URL, `WEB/checkout/<token>`, where the customer pays by:
- **UPI:** QR code, or open a UPI app on mobile, through the UPI providers;
- **cards, netbanking and wallets:** through an enabled payment gateway (docs/PAYMENT_GATEWAYS.md).

## 1. Websites

- **Adding:** merchants add their websites under **Developers → Websites**. Only the origin is stored, for example `https://shop.example.com`. Production requires `https`.
- **Review:** compliance reviews them under **Admin → Compliance → Websites** (`compliance.approve`). Rejecting needs a note.
- **Return URLs:** a session's `return_url` must be on an **approved** website of that merchant. This stops checkout being used to send customers to arbitrary sites.
- **Removal:** a website that sessions have used can't be removed.

## 2. Sessions

- **API:** `POST /v1/checkout/sessions` works with API keys or the dashboard and needs an `Idempotency-Key`. It takes `merchant_order_id` (unique per merchant), `amount`, `return_url`, an optional `customer`, `description`, `expires_in_seconds` (300–86400, default 1800) and `metadata`.
- **Public token:** the session is addressed publicly by a random 24-byte token, never by its id.
- **Attempts:** each try is a normal payment with `merchant_order_id = <order>#<n>` and `checkout_session_id` set. API order ids can't contain `#`, so attempts never collide with them. A session allows at most 10 attempts.
- **UPI reuse:** an open UPI attempt is shown again rather than creating a new one.
- **Paying:** the first successful attempt marks the session `PAID`, in the same transaction as the payment's success.
- **Status:** `OPEN → PAID | EXPIRED | CANCELLED`. Expiry is evaluated when the session is read. The merchant can cancel an open session, and so can the customer if no gateway attempt is in flight.
- **Return:** afterwards the customer is sent to `return_url` with `checkout_session_id`, `merchant_order_id` and `status` added. Merchants must confirm the order server-side, with `GET /v1/checkout/sessions/:id` or the `payment.success` webhook.

## 3. Public endpoints

All are rate-limited per token and per IP:
- `GET /v1/public/checkout/:token`: order, the merchant's display name, available methods and the latest attempt. The merchant's id is never exposed.
- `POST /v1/public/checkout/:token/pay`: `{ method: UPI | GATEWAY, customer: { name, email, mobile } }`.
- `GET /v1/public/checkout/:token/status`: what the page polls every 3 seconds while a payment is in flight.
- `POST /v1/public/checkout/:token/cancel`.

## 4. Not yet included

- **Automatic refund of a second payment:** if a customer pays twice, for example by UPI and by card at the same time, the session keeps the first payment. The second is a normal successful payment that the merchant can refund.
- **Branding per merchant:** the page shows the platform brand and the merchant's display name, but not a merchant logo or colour.
- **Iframe embedding:** not offered on purpose (the checkout can't be framed); use the popup (§5).

## 5. Popup checkout (checkout.js)

`WEB_PUBLIC_URL/js/v1/checkout.js` (no dependencies) lets a merchant keep the customer on its own page:

```js
Pay2All.checkout({ url, onSuccess, onFailure, onClose, onError });
```

- **`url`:** the session `url`, or a function / promise returning it. The popup window is opened synchronously inside the click (so it isn't blocked), shows "Opening secure payment…", and loads the checkout when the url arrives. Only `WEB_PUBLIC_URL/checkout/…` URLs are accepted.
- **Popup blocked:** the script falls back to the normal redirect.
- **The page in the popup** (`?embed=popup`, remembered in sessionStorage across gateway round-trips): when the session ends it `postMessage`s `{ source: 'pay2all', type: 'checkout.result', status, checkout_session_id, merchant_order_id, payment_id }` to `window.opener`, **only** with `targetOrigin` = the origin of the session's `return_url` (an approved website, exposed as `embed_origin`), then closes itself. Customer cancel works the same way.
- **The script** accepts messages only from the checkout origin and from its own popup window. It shows a "Complete your payment" overlay with *Show payment window* and *Cancel*, and calls `onClose` when the window is closed without a result.
- **Framing:** the checkout is never framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); a popup is used instead of an iframe.
- **Opener link:** if the merchant page sends `Cross-Origin-Opener-Policy: same-origin`, or a bank page in the flow cuts the opener link, no message arrives. The customer then lands on the `return_url` inside the popup and the merchant gets `onClose`. Results are UI hints either way; fulfil only after `GET /v1/checkout/sessions/:id` or the webhook.

Plugins and the PHP SDK are described in [INTEGRATIONS.md](./INTEGRATIONS.md).
