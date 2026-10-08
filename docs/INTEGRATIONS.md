# Plugins and SDKs

Source lives in `integrations/`. `apps/web/scripts/build-plugins.mjs` (run by the web `prebuild`) packs them into `apps/web/public/downloads/*.zip`. The zips are build output and are git-ignored. The merchant dashboard offers them under Developers → Integrations.

| Package | Path | Status |
| --- | --- | --- |
| PHP SDK (`Pay2All\Client`, `Pay2All\Webhook`) | `integrations/php` | Tested against the API (`apps/api/test/php-integrations.e2e-spec.ts`) |
| WooCommerce plugin | `integrations/woocommerce/pay2all-payments` | Plugin code tested against the API through a harness with WordPress/WooCommerce stand-ins; not yet run inside a real WordPress |
| OpenCart 4.0.2+ extension | `integrations/opencart/pay2all` | Beta: PHP syntax-checked only |
| Shopify | — | Not possible: Shopify checkout accepts only approved payment partners. Use payment links (docs/PAYMENT_LINKS.md) |

The PHP client is copied (byte-for-byte, enforced by a test) into each plugin so the plugins install standalone.

## PHP SDK

- `new Client($keyId, $secret, $apiBase)`; `request()` signs `${t}.${nonce}.${METHOD}.${path}.${sha256(body)}` exactly as docs/API.md §2 describes. POSTs carry an `Idempotency-Key` (pass a stable one, e.g. the order id).
- Helpers: `createCheckoutSession`, `getCheckoutSession`, `createPaymentLink`, `getPayment`, `refund`, `Client::amount()` (rupee strings).
- Errors throw `ApiException` with `errorCode`, `httpStatus`, `requestId`.
- `Webhook::verify($secret, $header, $raw)` does a constant-time check with a 5-minute tolerance and accepts any `v1` (secret rotation). `Webhook::parse($raw)` decodes a verified body.

## WooCommerce

- **Order flow:** a checkout session per attempt (`WC-<order>-<n>`, Idempotency-Key = that reference). The return URL goes to WooCommerce's API endpoint with the order key. On return the plugin fetches the session from the API, and only `PAID` with an amount equal to the order total marks the order paid (a different amount puts it on hold).
- **Webhook:** `?wc-api=pay2all_webhook` verifies the signature, maps `WC-<order>-<n>#k` to the order, and re-checks the session with the API.
- **Refunds:** `process_refund` calls `POST /v1/payments/:id/refunds` (needs a key with `payin.refund`).
- Available only when the store currency is INR. HPOS compatible.

## OpenCart

- **Order flow:** `OC-<order>-<base36 time>` references. The session id is kept in the customer's OpenCart session, and the return URL carries an HMAC of the order id.
- **Confirmation:** the order is completed on return or by the webhook, after the API reports `PAID` and the amount matches. A different amount gets the fraud status.
- **Refunds:** issue them from the Pay2All dashboard.
