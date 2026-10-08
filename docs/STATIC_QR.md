# Static QR codes

A static QR is printed once and displayed at a counter. Customers scan it with any UPI app, type the amount and pay. Each payment becomes a captured `UPI_STATIC_QR` payment of the merchant.

## 1. Model

- `static_qrs`: merchant, provider, the provider's QR id (unique per provider), label, `upi_payload` and/or `image_url` (a DB CHECK requires at least one), status `ACTIVE`/`CLOSED`, `last_credit_at`, `last_polled_at`.
- Payments made to it: `payments.method = UPI_STATIC_QR` and `payments.static_qr_id` (a DB CHECK ties the two together). Reference `SQR-<provider payment id>`, unique per merchant: this is what makes recording idempotent.

## 2. Issuing

- `POST /v1/static-qrs {label}` (merchant, `payin.create`). Routing is asked for `PAYIN` / `UPI_STATIC_QR`; the first candidate whose adapter implements the static QR capability issues the QR.
- Provider capability (`StaticQrProvider` in `@pay2all/providers`): `createStaticQr`, `closeStaticQr`, `listStaticQrCredits(qrId, since)`, plus `static_qr.credit` webhook events.
- **Implemented:**
  - **Sandbox (`mock`)**: issues `mockqr_<id>`; credits come only from the sandbox simulator.
  - **Razorpay**: QR Codes API (`upi_qr`, `multiple_use`, `fixed_amount: false`), `qr_code.credited` webhooks, `GET /v1/payments/qr_codes/:id/payments` for reconciliation. Tested against a local fake only — verify in Razorpay's sandbox before Live, including whether `image_content` (the UPI string) is returned for your account.
- **Enabling it on a provider:** the provider's capabilities must include `UPI_STATIC_QR` (Razorpay gets it when connected) and a payin route must cover the method (Providers → Routing: method `UPI_STATIC_QR`, or a route with method "Any").
- Up to 25 active QR codes per merchant. `POST /v1/static-qrs/:id/close` closes it at the provider (after one last reconciliation poll); a closed QR can't be reopened.

## 3. Recording a credit

1. A verified provider webhook (`static_qr.credit`, status SUCCESS) or the reconciliation poller reports `{provider payment id, amount, UTR, payer VPA}`. The amount always comes from the provider.
2. The payment is created and captured in one ledger transaction: pricing quote for `UPI_STATIC_QR` (scheme provider "Static QR"), pricing snapshot, period usage, `payment.created`, then `applyOutcome(SUCCESS)` (capture journal, `payment.success` webhook, settlement as usual).
3. Limits and risk pre-checks are **not** applied: the money has already arrived. If fees would exceed a tiny payment, they are capped at its amount (scheme commission is then dropped).
4. A repeat (webhook retry, poller, duplicate event) finds the existing reference and records nothing.

## 4. Reconciliation

The jobs process runs `static-qr-reconcile` every minute: active QRs not polled for 5 minutes list their credits since `min(last credit, last poll) − 24 h` and record any the webhook missed (logged as a warning).

## 5. Dashboard

Payin → QR codes → *Static QR*:

- Create, view today's total and count, see the list of payments.
- Download a print-ready standee PNG (merchant name, QR, instructions), drawn in the browser.
- Close a QR.
- In sandbox builds: *Simulate payment*, which calls `POST /v1/sandbox/static-qrs/:id/pay` (mock providers in TEST only) to send a signed callback.
