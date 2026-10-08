# Payment gateways

Super admins connect hosted payment gateways under **Admin → Settings → Payment Gateways** by entering credentials only; every integration is built in.

| Gateway | Adapter | Integration | Callback authentication |
| --- | --- | --- | --- |
| Razorpay | `razorpay` | Payment Links API, Basic auth | HMAC-SHA256 of the body (`X-Razorpay-Signature`) |
| Cashfree | `cashfree` | Payment Links API (2023-08-01) | base64 HMAC-SHA256 of timestamp + body |
| Easebuzz | `easebuzz` | Initiate Payment + Transaction / Refund APIs | SHA-512 reverse hash with the salt |
| CCAvenue | `ccavenue` | Non-seamless form post + Order Status / Refund APIs | Not authenticatable (see below) |
| HDFC SmartGateway | `hdfc` | Juspay Session / Order / Refund APIs | Basic auth you configure |
| NTT DATA (Atom) | `nttdata` | AIPAY token + Atom checkout script | HMAC-SHA512 response signature |
| PhonePe PG | `phonepe` | Standard Checkout v2 (OAuth token) | SHA-256(username:password) header |

## 1. How a gateway is wired in

Connecting a gateway creates a normal **PAYIN provider**: its code and adapter are the gateway key. It also gets a **PAYMENT_LINK route**, with default priority 10 and inactive until enabled. Everything providers already have therefore applies unchanged:
- routing with failover;
- health tracking;
- webhooks at `/v1/webhooks/providers/<key>`;
- status polling;
- refunds;
- reconciliation;
- pricing snapshots.

Credentials:
- **Storage:** encrypted per environment (TEST / LIVE) with AAD `providerId:environment`.
- **Write-only:** the page shows key names and their last 4 characters only.
- **Partial updates:** saving merges new values with the stored ones, so you can rotate one field without re-entering the others.

## 2. Connect, test, enable

1. **Save credentials** for Test or Live, with a reason (audited).
2. **Test connection.** This makes an authenticated call: a list or unknown-order lookup, or a token request for PhonePe. The result is stored.
3. **Enable.** This is refused unless the last test passed **with the current credentials and environment**. Changing credentials or the environment clears the test result.
4. **Set up the gateway dashboard.** Configure the webhook URL and the gateway-specific steps shown on the page.

Disabling turns off the route. Credentials can be removed for an environment the gateway is not running in.

## 3. Customer return and outcome

- **Return URL:** every payment carries the return URL `/v1/checkout/return/:payment_id`, set automatically.
- **Outcome comes from the gateway's API:** when the customer comes back by GET or POST, we ask the gateway's status API, apply the result, and redirect to the checkout page. **Nothing the browser brings back is trusted.** To make this work for form-posting gateways, form bodies are parsed only on `/v1/checkout/return` and `/v1/webhooks/providers`; the rest of the API stays JSON-only.
- **CCAvenue:** CCAvenue encrypts with AES-128-CBC without a MAC, and its responses pass through the customer's browser, so they can be tampered with.
  - A CCAvenue notification is only a nudge (`confirmByStatusApi`): it schedules an immediate status poll.
  - The Order Status API decides the outcome.
  - The integration test covers a forged "Success" callback that the API overrules.
- **Form-post and script gateways (CCAvenue, NTT DATA):** these are handed off by an API-served page at `/v1/checkout/pay/:payment_id` with its own CSP:
  - scripts by nonce only, plus Atom's script host;
  - `form-action` limited to the gateway;
  - `frame-ancestors 'none'`.

## 4. Gateway notes

- **Razorpay:** test or live is decided by the key (`rzp_test_` / `rzp_live_`). `expire_by` must be at least 15 minutes ahead.
- **Cashfree:** the customer's mobile number is required. Refunds go against the paid order behind the link.
- **Easebuzz:** name, email and mobile are required. Hash sequence `key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt`.
- **CCAvenue:** API calls need the server's outbound IP whitelisted at CCAvenue. Order ids are the payment id without the `_`.
- **HDFC SmartGateway:** order ids are limited to 21 characters, so they are the last 21 characters of the payment id. Webhooks use the Basic credentials you enter.
- **NTT DATA:** keys are AES-256-CBC with PBKDF2-HMAC-SHA512 (65 536 iterations). Status lookups need the original transaction date, which is derived from the payment id's ULID time. **Refunds are made in the NTT DATA dashboard**; there is no refund API integration.
- **PhonePe:** OAuth tokens are cached per client until shortly before they expire.

## 5. Verification status

Each adapter is covered by unit tests against a local fake server. These verify:
- request signing, hashes, encryption and encodings;
- status mapping;
- webhook acceptance, and rejection of tampered or unsigned callbacks.

The checkout integration tests run Razorpay and CCAvenue end to end against fakes. **None has been run against the gateways' real sandboxes yet**, which needs your test credentials. Test each gateway in its sandbox before enabling it in Live.

## 6. API (super admins)

| Route | |
| --- | --- |
| `GET /v1/gateways` | Catalog, connection state, webhook URLs |
| `PUT /v1/gateways/:key` | `{ environment, credentials, priority?, reason }` |
| `POST /v1/gateways/:key/test` | Live connection test |
| `POST /v1/gateways/:key/enabled` | `{ enabled, reason }` |
| `POST /v1/gateways/:key/credentials/remove` | `{ environment, reason }` |
