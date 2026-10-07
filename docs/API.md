# Public API: Credentials & Request Signing

> Status: implemented in Phase 9. Related: [SECURITY.md](./SECURITY.md) §6, [WEBHOOKS.md](./WEBHOOKS.md), [RESELLERS.md](./RESELLERS.md)

## 1. API keys

- **Who and where.** Merchant and API-partner admins create keys under **Developers → API keys**. A deployment accepts the keys of one environment only (`API_ENVIRONMENT`): a sandbox issues `pk_test_…` / `sk_test_…`, and live issues `pk_live_…` / `sk_live_…`. Test and live data therefore never mix.
- **Secret.** Generated server-side (`sk_` + 32 random bytes) and **shown once**. HMAC verification needs it, so it is stored AES-256-GCM encrypted with the key id as associated data. Lists and audit logs show only the last four characters.
- **Permissions.** Chosen from the API set: create/read/refund payments, create/read payouts, beneficiaries, settlements, balances. They are always a subset of the creator's own permissions.
- **Not available to keys.** Approvals, bulk payouts, team, keys, webhooks configuration and every other dashboard-only route reject API keys (403). Routes opt in with `@ApiKeyAccess`, so new routes are dashboard-only by default.
- **Rotation.** Rotating issues a new key with the same name and permissions. The old key keeps working for an overlap (default 24 h, 0 = revoke now), after which it fails.
- **Limits.** At most 10 active keys per organization. 600 requests per minute per key by default.

## 2. Signing a request

| Header | Value |
| --- | --- |
| `X-Pay2All-Key` | public key id |
| `X-Pay2All-Timestamp` | unix seconds, within ±300 s of the server clock |
| `X-Pay2All-Nonce` | 16–64 chars `[A-Za-z0-9_-]`, fresh per request (a UUID) |
| `X-Pay2All-Signature` | `v1=` + hex HMAC-SHA256(secret, `<timestamp>.<nonce>.<METHOD>.<path with query>.<sha256 hex of the raw body>`) |
| `Idempotency-Key` | required on `POST /v1/payments`, `/v1/payouts`, `/v1/payments/:id/refunds` |
| `X-Pay2All-Merchant` | API partners only: the child merchant (`org_…`) to act for |

Server checks, in order:
1. The key exists and is ACTIVE and unexpired.
2. The key's environment matches the deployment.
3. The timestamp is within tolerance.
4. The signature verifies, compared in constant time.
5. The **nonce has not been used** by this key, enforced with Redis `SET NX` and a 10-minute TTL. A captured request can't be replayed, and identical legitimate requests (polling) still work because each carries its own nonce.
6. The organization is active.
7. The **IP allowlist** passes (CIDR; enforced once the organization has entries for the environment) → `403 IP_NOT_ALLOWED`.
8. The **per-key rate limit** passes (`RateLimit-Limit/-Remaining/-Reset`; `429` with `Retry-After`).

Authentication failures are a uniform `401`, so the response never reveals which check failed. An IP address that accumulates 60 failures per minute is throttled before any key lookup.

The Node, Python and cURL samples are on **Developers → Documentation** in the dashboard.

## 3. Attribution and logs

- **Attribution.** An API-key actor's id is the key id. It appears as `created_by` on payments and payouts and as an `API_KEY` actor in the audit log. Payouts created by a key still go through maker-checker; every human approver qualifies.
- **Request logs.** Every key-authenticated request is logged once the response finishes: method, path (no query string), status, error code, duration, client IP, request id, key and partner. No bodies are stored. Logs are kept for 90 days.
- **Dashboards.** **Developers → API logs** shows usage (requests per day, error rate, p95, top errors and endpoints) and the request log.

## 4. API partners

API partners are integration platforms that operate merchants:
- **Merchants.** Partners create merchants under themselves, and platform staff can place merchants under a partner. Those merchants complete KYC like any other.
- **Dashboard.** The partner's dashboard sees its merchants' payments and payouts, using the same tenancy as resellers.
- **API.** A partner key acts for one of its merchants by sending `X-Pay2All-Merchant`, which is verified against the organization hierarchy. The request then runs as that merchant, limited to the key's permissions, and the log records the partner. A merchant that isn't the partner's returns `404`. Merchant keys can't use the header.
