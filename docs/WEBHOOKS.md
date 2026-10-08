# Merchant Webhooks

> Status: implemented in Phase 7. Related: [SECURITY.md](./SECURITY.md) §7, [ARCHITECTURE.md](./ARCHITECTURE.md) §8

Pay2All sends an HTTPS `POST` to your endpoint when something happens to your payments, refunds or payouts. Configure endpoints under **Developers → Webhooks**. Every delivery is in **Developers → Webhook log**, where you can also replay it.

## Events

| Event | When |
| --- | --- |
| `payment.created` | A payment was created |
| `payment.pending` | The collect request is live (QR / intent / link issued) |
| `payment.success` | The bank confirmed the payment. Funds are credited to your unsettled balance. The payload includes `late_success: true` for confirmations after expiry. |
| `payment.failed` | The payment failed or expired |
| `refund.created` / `refund.success` / `refund.failed` | Refund lifecycle. A failed refund's amount is returned to your balance. |
| `payout.created` | A payout was created and funds were reserved |
| `payout.queued` | The payout is approved (or needed no approval) and waiting to be sent |
| `payout.processing` | The bank accepted the transfer |
| `payout.success` | Credited to the beneficiary (`utr` included) |
| `payout.failed` / `payout.rejected` | Not paid. The reserved funds are back in your available balance. |
| `payout.reversed` | The beneficiary bank returned a successful payout. The principal is back in your available balance. |
| `webhook.test` | Sent by **Send test event** |

An endpoint can subscribe to specific events or to all of them, including types added later.

Dispute events (docs/DISPUTES.md): `dispute.created`, `dispute.updated`, `dispute.won`, `dispute.lost`. Each carries the dispute object: id, payment_id, amount, status, respond_by, reason and outcome fields.

## Request

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Pay2All-Webhooks/1.0
Pay2All-Event-Id: evt_01JA9C2D4F6G8H0J2K4M6N8P0Q
Pay2All-Event-Type: payment.success
Pay2All-Delivery-Id: whd_01JA…
Pay2All-Delivery-Attempt: 1
Pay2All-Signature: t=1791297600,v1=5f2c…

{"id":"evt_01JA…","type":"payment.success","created_at":"2026-10-07T10:00:00.000Z","data":{"payment_id":"pay_01JA…","merchant_order_id":"ORD-1001","amount":"1000.00","status":"SUCCESS","utr":"412345678901", …}}
```

The `data` object is the same resource you get from the API (`GET /v1/payments/:id`, `/v1/payouts/:id`). Amounts are rupee strings. Full account numbers, payer details beyond what the API shows, and secrets are never included.

## Verifying signatures

The `v1` value is the hex HMAC-SHA256 of `<t>.<raw request body>`, keyed with your endpoint's signing secret.

1. Compute the HMAC over the **raw bytes** you received, before any JSON parsing.
2. Compare it in constant time with **any** `v1` value in the header.
3. Reject the request if `t` is more than 5 minutes from your clock. This stops replays.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, tolerance = 300) {
  const parts = Object.groupBy(header.split(','), (p) => p.split('=')[0]);
  const t = Number(parts.t?.[0].split('=')[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return (parts.v1 ?? []).some((p) => { const v = Buffer.from(p.slice(3)); return v.length === expected.length && timingSafeEqual(v, expected); });
}
```

```python
import hmac, hashlib, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    items = [p.split("=", 1) for p in header.split(",")]
    t = next((int(v) for k, v in items if k == "t"), None)
    if t is None or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(v, expected) for k, v in items if k == "v1")
```

### Secret rotation

**Rotate secret** issues a new secret, which is shown once. For the next 24 hours every delivery is signed with **both** the new and the old secret, so the header carries two `v1` values. Deploy the new secret within that window. After it, only the new secret signs.

## Responding, retries and ordering

- Return any **2xx within 10 seconds**. Do slow work asynchronously after acknowledging.
- **Redirects are not followed.** A 3xx counts as a failure.
- Failed deliveries are retried after 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h and 24 h: 9 attempts over about 2 days. After that the delivery is marked failed, and you can replay it from the log.
- Delivery is **at least once**. Use the `id` (event id) to make your handler idempotent, because the same event can arrive more than once.
- Events for one resource are produced in order, but retries can deliver them out of order. Always trust the `status` in the payload, or fetch the resource, rather than the arrival order.
- After **100 consecutive failed attempts**, an endpoint is disabled automatically and your admins are emailed. Enable it again once it is fixed, then replay what was missed.

## Endpoint requirements

- `https` URLs in production, without credentials in the URL. At most 10 endpoints per account.
- The endpoint must resolve to a public address. Private, loopback, link-local and metadata addresses are refused at every delivery, not only when the endpoint is saved.
