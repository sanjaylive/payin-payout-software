# Security Architecture

Scope: authentication, authorization (RBAC), multi-tenant isolation, API request signing, webhook signing, encryption, secrets, logging hygiene, abuse prevention and audit.

## 1. Dashboard authentication (Phase 1)

### 1.1 Credentials

- Users log in with **email or mobile** plus a password. The identifier is normalised: email lower-cased, mobile converted to E.164 (`+91…`).
- Passwords are hashed with **argon2id** (`memoryCost 19 MiB, timeCost 2, parallelism 1`, the OWASP 2024 minimum, tunable through config). The hash string embeds its parameters, so they can be raised later and hashes upgrade on the next login.
- **Password policy:** 12–128 characters, must not contain the email local-part or mobile, and must not equal the current password. A breached-password check (HIBP k-anonymity) is planned for Phase 10.
- **Unknown user:** login still runs an argon2 verify against a fixed dummy hash, so response timing does not reveal whether an account exists. The error is always `INVALID_CREDENTIALS`.

### 1.2 Brute-force protection

| Layer | Policy |
| --- | --- |
| Per account | `failedLoginCount` increments on each failure. After `AUTH_MAX_FAILED_LOGINS` (5) the account is locked for `AUTH_LOCKOUT_SECONDS` (15 min). Lock and unlock are audited. A successful login resets the counter. |
| Per IP | Redis sliding window: 20 login attempts / 5 min / IP, then `429 RATE_LIMITED`. |
| Per identifier | 10 attempts / 15 min per normalised identifier across all IPs, which slows credential stuffing against one account. |
| Password reset | 5 requests / hour per identifier, 20 / hour per IP. The response is always `200` so account existence is not revealed. |
| MFA verify | 5 wrong codes in a challenge invalidate that challenge. |

Every login success or failure, lockout, password change/reset, MFA change and session revocation writes an `audit_logs` row (`auth.*` actions).

### 1.3 Tokens and sessions

```
POST /v1/auth/login ─▶ (MFA?) ─▶ Session row created
   access token  : JWT HS256, 15 min, claims { sub, sid, org, typ:"access" }  → returned in JSON, kept in memory by the web app
   refresh token : 256-bit random, opaque → Set-Cookie p2a_rt (httpOnly, Secure, SameSite=Strict, Path=/v1/auth)
                   stored server-side only as SHA-256(token)
```

- **Rotation:** each `POST /v1/auth/refresh` consumes the presented refresh token (`UPDATE … SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL`, which is atomic) and issues a new one in the same session.
- **Reuse detection:** if a token that was already used is presented, the whole session is revoked (`revokedReason = REFRESH_TOKEN_REUSE`), an audit event is written, and a `security.suspicious_activity` event is emitted. This defeats a stolen refresh token used in parallel with the legitimate client.
  - *Grace window:* a reuse within 10 s from the same session (two browser tabs refreshing at once) returns `401` without revoking.
- **Expiry:** refresh tokens expire after an absolute 14 days, and sessions expire after `AUTH_SESSION_IDLE_SECONDS` of inactivity.
- **Immediate revocation:** access JWTs are short-lived, and revoking a session (logout, logout-all, admin disable, password reset) also writes `revoked_session:<sid>` into Redis with a TTL equal to the access-token lifetime. The auth guard checks this key, so revocation takes effect on the next request, not after 15 minutes.
- **Endpoints:** `GET /v1/auth/sessions` lists the caller's active sessions, `DELETE /v1/auth/sessions/:id` logs out one session, and `POST /v1/auth/logout-all` revokes every session for the user.
- **Password reset** revokes all sessions. **Password change** revokes all sessions except the current one.

### 1.4 CSRF strategy

- API calls authenticate with `Authorization: Bearer <access>`, a header the browser never attaches automatically. These calls are not CSRF-able.
- Only `/v1/auth/refresh` and `/v1/auth/logout` use the cookie. For those endpoints:
  1. The cookie is `SameSite=Strict` and path-scoped to `/v1/auth`.
  2. The API requires the custom header `X-Pay2All-CSRF: 1`. A cross-site form cannot set it, and a cross-origin `fetch` cannot set it without passing the CORS preflight.
  3. The `Origin` header must match `CORS_ALLOWED_ORIGINS`.

### 1.5 MFA (TOTP)

- RFC 6238 TOTP: SHA-1, 6 digits, 30 s step, ±1 step drift. The secret is generated server-side and stored **encrypted** (`MfaFactor.secretEncrypted`).
- **Enrollment:** `POST /v1/auth/mfa/totp/setup` returns an otpauth URI and QR, creating a PENDING factor. `POST /v1/auth/mfa/totp/enable` with a valid code activates it.
- **Replay prevention:** `lastUsedStep` is stored, and a code from the same or an earlier step is rejected.
- **Login with MFA:** the password step returns `{ mfa_required: true, mfa_token }`, a 5-minute JWT with `typ:"mfa"`. `POST /v1/auth/mfa/verify` with the code creates the session. No session or refresh token exists before MFA succeeds.
- **Mandatory MFA:** roles with `requiresMfa` are all platform staff roles and RESELLER. If such a user has no active factor, login creates a **restricted session** (`mfaEnrollmentRequired`). In a restricted session the guard allows only routes marked `@AllowRestrictedSession()` (`/auth/me`, MFA setup/enable, logout). Controlled by `AUTH_ENFORCE_MFA`.
- **Recovery codes:** 10 single-use 50-bit codes (`ABCDE-FGH23`), returned once at enrollment and on regeneration (which needs a current TOTP code). They are stored as a keyed HMAC (blind index) rather than a slow hash, so a leaked table alone cannot be brute-forced offline. Consuming one is race-safe, audited and emailed to the user.
- **Admin MFA reset:** platform staff with `user.manage` can reset another user's MFA, but not their own. A reason is required. The reset disables all factors and codes, revokes every session, writes an audit entry and emails the user.

## 2. Authorization: RBAC + permissions

### 2.1 Model

```
Permission (key)  ◀── RolePermission ──▶  Role (key, scope = org type, requiresMfa)
                                            ▲
User ──▶ UserRole (user × role × organization)  ── membership
```

- The **permission catalog** is defined in code: `packages/auth/src/permissions.ts`. Each permission declares the org types it may be granted in. `merchant.approve` and `provider.manage` are PLATFORM-only, so a custom merchant role can never receive them, even through a bug in role editing.
- **System roles** are defined in `packages/auth/src/roles.ts`, and the seed and sync script upserts them:

| Scope | Roles |
| --- | --- |
| PLATFORM | `SUPER_ADMIN`, `ADMIN`, `COMPLIANCE`, `FINANCE`, `OPERATIONS`, `SUPPORT`, `SALES` |
| RESELLER | `RESELLER` (reseller org administrator) |
| API_PARTNER | `API_PARTNER` |
| MERCHANT | `MERCHANT_OWNER`, `MERCHANT_ADMIN`, `MERCHANT_DEVELOPER`, `MERCHANT_FINANCE`, `MERCHANT_OPERATIONS`, `MERCHANT_VIEWER` (UI labels: Owner, Admin, Developer, …) |

  The top-level "MERCHANT" user type is the merchant org type, and a merchant user always holds one of the merchant team roles.

### 2.2 Enforcement

```ts
@RequirePermissions('payout.approve')          // all listed permissions required
@Post('payouts/:id/approve')
approve(@Actor() actor: ActorContext, …)
```

- `PermissionGuard` resolves the actor's permission set for the **active organization** of the session. The set is the union over their roles in that org, cached in Redis as `perm:<userId>:<orgId>` for 60 s and invalidated when a role is granted or revoked.
- A permission answers "may perform this action". **Tenant scope** answers "on which records" (§3). Both checks always apply.
- **Policies** cover rules that permissions cannot express, such as maker ≠ checker or "only OWNER can remove another OWNER". They live in the module's `*.policy.ts` and run in the service.
- Role-name checks (`if (role === 'SUPER_ADMIN')`) are not allowed in business code.
- **Privilege escalation guard:** a user can grant only roles whose permission set is a subset of their own, within their own scope.

## 3. Multi-tenancy isolation

1. **Tenant context comes from credentials only.** For dashboard calls that means `session.organizationId`. For API calls it is `apiKey.organizationId` (Phase 9). `merchantId`, `organizationId` and `resellerId` fields in request bodies are rejected by the Zod schemas for tenant-facing endpoints.
2. **`ActorContext`** is created by the auth guard and stored in AsyncLocalStorage:
   `{ userId, sessionId, organizationId, organizationType, roleKeys, permissions, scope }`
3. **Scope resolution (`TenantScopeService`):**
   - PLATFORM → `{ kind: 'ALL' }`
   - RESELLER → `{ kind: 'RESELLER', resellerOrgId }`, which allows the reseller org itself and rows whose `resellerId` equals it
   - API_PARTNER → `{ kind: 'ORGS', orgIds: [self, ...mappedMerchants] }`
   - MERCHANT → `{ kind: 'ORG', orgId }`
4. Repositories compose `scope.where()` into every query on tenant-owned tables. **Single-record reads are `findFirst({ where: { id, ...scope } })`**. Never fetch by ID and then compare the tenant afterwards, a pattern that tends to get forgotten.
5. **Out of scope returns `404 NOT_FOUND`**, not 403, so resource existence never leaks.
6. Platform staff targeting a tenant is audited (`resourceType`/`resourceId` and the acting org).
7. Every tenant-facing endpoint has an integration test for cross-tenant access. For example, merchant A requests merchant B's user, gets 404, and the query is never executed unscoped.
8. **Planned hardening (Phase 10):** PostgreSQL Row-Level Security on the highest-risk tables as a second net, using `SET LOCAL app.org_scope` per transaction.

## 4. Encryption & secrets

| Data | Protection |
| --- | --- |
| Passwords, recovery codes | argon2id hash (one-way) |
| Refresh tokens, reset tokens | SHA-256 hash (high-entropy random input, so a slow hash is unnecessary) |
| MFA secrets, provider credentials, webhook secrets, API secrets, bank account numbers, PAN of directors | AES-256-GCM, a random 96-bit IV per value, versioned envelope `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url) |
| Bank account dedupe | `HMAC-SHA256(ENCRYPTION_KEY-derived subkey, normalised account)`, which allows equality lookups without decryption |
| Displayed account numbers | stored masked copy `XXXXXX1234`. The full number is decrypted only for provider calls and an audited "reveal" permission. |

- **Key management:** `ENCRYPTION_KEY` plus `ENCRYPTION_KEY_ID` come from the environment, behind a `SecretProvider` abstraction so AWS KMS, GCP KMS or Vault can be plugged in later. The key ID is stored in every envelope, so rotation means adding the new key, re-encrypting in the background, then retiring the old key.
- **Boot validation:** env validation (Zod) rejects placeholder or short secrets in `production`, and fails the boot if `JWT_ACCESS_SECRET == JWT_REFRESH_SECRET`.

## 5. Logging hygiene

The pino redaction list is centralised in `packages/logger` and **cannot be disabled**. It covers:

`password`, `newPassword`, `currentPassword`, `token`, `accessToken`, `refreshToken`, `access_token`, `refresh_token`, `mfa_token`, `otp`, `secret`, `apiSecret`, `api_secret`, `secretEncrypted`, `authorization` / `cookie` / `set-cookie` headers, `x-pay2all-signature`, `accountNumber`, `account_number`, `credentials`, `encryptionKey`.

- Request bodies are **not** logged by default.
- Provider request and response payloads go through `redactProviderPayload()` before persistence in `*_attempts` tables.
- Sentry events use the same scrubber.

## 6. Public API security (Phase 9)

**Credentials:** `pk_live_…` / `pk_test_…` is the public key ID, and `sk_live_…` is the secret, shown once.

- The secret is stored **encrypted**, not hashed, because HMAC verification needs it. A SHA-256 hash is also stored for constant-time existence checks, along with `secretLast4` for display.
- **Rotation:** creating a new key leaves the old key valid until an optional `expiresAt` overlap window ends.

**Request signing:**

```
X-Pay2All-Key:       pk_live_…
X-Pay2All-Timestamp: 1767225600            (unix seconds)
X-Pay2All-Signature: v1=hex(HMAC_SHA256(secret, `${timestamp}.${METHOD}.${pathWithQuery}.${sha256hex(rawBody)}`))
```

- The timestamp must be within ±300 s. The `(key, signature)` pair is stored in Redis with a 600 s TTL using `SET NX`, so a repeated signature is rejected as a replay.
- Comparison is constant-time (`crypto.timingSafeEqual`).
- **IP allowlist:** checked per organization and environment (CIDR) after signature verification. A failure returns `403 IP_NOT_ALLOWED` and creates an audit or security event.
- **Rate limits:** Redis token bucket per API key, with per-merchant overrides (`RateLimitPolicy`). Responses carry `RateLimit-*` headers.
- **Idempotency:** `Idempotency-Key` is required on `POST /v1/payments`, `/v1/payouts` and `/v1/payments/:id/refunds`. See PAYIN_FLOW.md and PAYOUT_FLOW.md.

## 7. Webhook signing (Phase 7)

```
X-Pay2All-Event-Id:  evt_01J…
X-Pay2All-Timestamp: 1767225600
X-Pay2All-Signature: v1=hex(HMAC_SHA256(endpointSecret, `${eventId}.${timestamp}.${rawBody}`))
```

- Each endpoint has its own secret, which can be rotated. During rotation both signatures are sent: `v1=…,v1=…`.
- The receiver guide (in the docs) tells merchants to verify the signature, enforce the timestamp tolerance and dedupe on `event_id`.
- **SSRF protection:** endpoints must be `https` in LIVE. Resolved IPs in private, link-local or loopback ranges are refused at delivery time, not only when the URL is saved. Redirects are not followed.

## 8. HTTP hardening

- **Helmet:** a strict CSP on the API (`default-src 'none'`, relaxed only for the `/docs` Swagger route), HSTS in production, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, frameguard deny.
- **CORS:** an explicit allowlist, with credentials only for listed origins.
- **Body limits:** 1 MB by default, larger only on upload routes.
- **KYC uploads (Phase 2 decision):** files go *through the API*, not browser-direct pre-signed URLs, so the server enforces all of the following before anything is stored:
  - a size cap (`MAX_DOCUMENT_BYTES`);
  - content checks by magic bytes, accepting PDF, PNG and JPEG only, with the client MIME type ignored;
  - a sha256 computed server-side;
  - a storage key made of server IDs only, with the client filename used for display only and sanitised.
- **KYC downloads** stream through the API after authorization. Each one is audited (`merchant.document.viewed`) and sent with `Content-Disposition: attachment`, `Cache-Control: no-store` and a `sandbox` CSP.
- **Encryption at rest** of the bucket (`S3_SSE`) is mandatory in production.
- **Input validation:** strict Zod objects reject unknown keys. Prisma parameterises queries. Raw SQL uses tagged templates only, and `$queryRawUnsafe` is lint-banned.
- **Web app:** React escapes output, `dangerouslySetInnerHTML` is lint-banned, and Next.js sends a CSP with nonces in production.
- **Trusted proxies:** `TRUST_PROXY_HOPS` sets how many proxies to trust, so `X-Forwarded-For` cannot be spoofed when no proxy is present.

## 9. Audit log

- **Append-only, enforced in two places:**
  - The DB trigger `audit_logs_immutable` raises an exception on `UPDATE` or `DELETE`.
  - The application role grants are planned for production: `INSERT, SELECT` only on `audit_logs`.
- **Fields:** `actorId`, `actorRole`, `organizationId`, `action`, `resourceType`, `resourceId`, `oldValue`, `newValue`, `ipAddress`, `userAgent`, `requestId`, `createdAt`.
- **Atomicity:** `AuditService.record(tx, …)` is called **inside the same transaction** as the change it describes. Either both commit or neither does.
- **Redaction:** old and new values pass through the same redaction rules, so secrets never enter the audit trail.
- **Actions** use dotted names: `auth.login.succeeded`, `auth.login.failed`, `user.created`, `role.granted`, `merchant.approved`, `pricing.updated`, `payout.approved`, `ledger.adjustment.created`, `api_key.revoked`, `settlement.hold.placed`, ….

## 10. Suspicious activity signals

The following emit `security.*` events. In Phase 1 these are audit rows, in Phase 7 they go to the outbox, and in Phase 10 they feed the risk engine:

- refresh-token reuse
- login from a new IP or country for privileged roles
- repeated MFA failures
- lockouts
- an IP allowlist violation
- replayed signatures
- a mass export by one user
- a permission-denied burst
