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

### 1.6 Login history (login_events)

Every sign-in attempt is recorded, append-only (enforced by a trigger, like `audit_logs`).

**What a record holds:**
- outcome: SUCCESS, MFA_REQUIRED, MFA_FAILED, BAD_PASSWORD, LOCKED, DISABLED, NOT_ACTIVATED, NO_ACTIVE_ORGANIZATION or UNKNOWN_USER;
- the masked identifier;
- user, organization and session;
- IP address, and the user agent summarised into browser, OS and device type.

**Location:** taken only from the **browser's own geolocation**, and only when the user allows it on the sign-in page. The site's Permissions-Policy is `geolocation=(self)`. Latitude/longitude (6 dp) and the accuracy radius are stored. IPs are never sent to third-party geo-lookup services.

**Who sees it:** merchants see their own organization (Team → Login activity); resellers and partners see their merchants; platform staff see any merchant (Admin → Merchant → Login activity).

**Export:**
- **Download:** an immediate CSV (up to 10,000 rows), audited.
- **Email me:** an async export (`LOGIN_EVENTS` report, exported under the RLS reader role). The requester is emailed a **link** to the reports page, never the data, so download still needs a signed-in, authorised session.

### 1.7 Platform staff managing a merchant's integrations

`merchant.integration.manage` (Super Admin, Admin) allows managing a merchant's webhook endpoints and API IP allowlist on its behalf.

- **Routes:** these are explicit `/v1/admin/merchants/:merchantId/...` routes. The merchant is never inferred.
- **Audit:** every change is audited with `on_behalf: true`.
- **Signing secrets:** created or rotated secrets are shown once to the staff member, who must pass them on securely, or the merchant rotates the secret itself.
- **Generic routes are unchanged:** there, platform staff can still only disable an endpoint.

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
8. **Row-level security (Phase 10):** a second, database-level net for report exports (§11).

## 4. Encryption & secrets

| Data | Protection |
| --- | --- |
| Passwords, recovery codes | argon2id hash (one-way) |
| Refresh tokens, reset tokens | SHA-256 hash (high-entropy random input, so a slow hash is unnecessary) |
| MFA secrets, provider credentials, messaging-service credentials (SES keys, sms21 API key), webhook secrets, API secrets, bank account numbers, PAN of directors | AES-256-GCM, a random 96-bit IV per value, versioned envelope `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url) |
| Bank account dedupe | `HMAC-SHA256(ENCRYPTION_KEY-derived subkey, normalised account)`, which allows equality lookups without decryption |
| Displayed account numbers | stored masked copy `XXXXXX1234`. The full number is decrypted only for provider calls and an audited "reveal" permission. |

- **Key management:** `ENCRYPTION_KEY` plus `ENCRYPTION_KEY_ID` come from the environment, behind a `SecretProvider` abstraction so AWS KMS, GCP KMS or Vault can be plugged in later. The key ID is stored in every envelope, so rotation means adding the new key, re-encrypting in the background, then retiring the old key.
- **Boot validation:** env validation (Zod) rejects placeholder or short secrets in `production`, and fails the boot if `JWT_ACCESS_SECRET == JWT_REFRESH_SECRET`.

## 5. Logging hygiene

The pino redaction list is centralised in `packages/logger` and **cannot be disabled**. It covers:

`password`, `newPassword`, `currentPassword`, `token`, `accessToken`, `refreshToken`, `access_token`, `refresh_token`, `mfa_token`, `otp`, `secret`, `apiSecret`, `api_secret`, `secretEncrypted`, `authorization` / `cookie` / `set-cookie` headers, `x-pay2all-signature`, `accountNumber`, `account_number`, `credentials`, `encryptionKey`.

- Request bodies are **not** logged by default.
- Provider request and response payloads go through `redactProviderPayload()` before persistence in `*_attempts` tables.
- Error reports (Sentry protocol, docs/OBSERVABILITY.md §4) drop request bodies, headers, cookies, query strings, users and breadcrumbs, and redact secret-looking keys before sending.
- Traces carry parameterised SQL only (no bound values) and Redis command names only (no keys or arguments).

## 6. Public API security (Phase 9)

Full specification: [API.md](./API.md).

- **Credentials.** `pk_test_…` / `pk_live_…` is the public key id, and `sk_…` is the secret, shown once. HMAC verification needs the secret, so it is stored **encrypted** (AAD = key id), not hashed. Only `secretLast4` is ever displayed. Key permissions are a subset of the creator's. **Rotation** leaves the old key valid for an overlap window (default 24 h).
- **Request signing:**

```
X-Pay2All-Key:       pk_live_…
X-Pay2All-Timestamp: 1767225600            (unix seconds, ±300 s)
X-Pay2All-Nonce:     6f1c0e2a-…            (fresh per request)
X-Pay2All-Signature: v1=hex(HMAC_SHA256(secret, `${timestamp}.${nonce}.${METHOD}.${pathWithQuery}.${sha256hex(rawBody)}`))
```

- **Replay protection.** Each nonce is accepted once per key (Redis `SET NX`, 10-minute TTL). This replaces the original "store the signature" design, which would have rejected two legitimately identical requests made in the same second. Comparison is constant-time.
- **IP allowlist:**
  - checked per organization and environment (CIDR, via `net.BlockList`) after signature verification;
  - enforced once entries exist;
  - a failure returns `403 IP_NOT_ALLOWED` and is logged.
- **Rate limits:**
  - a sliding window per API key (`RateLimit-*` headers; `429` + `Retry-After`);
  - IPs with repeated authentication failures are throttled before key lookup.
- **Surface.** Only routes marked `@ApiKeyAccess` accept keys. Dashboard-only actions (approvals, keys, team, webhooks configuration) always reject them, and API-key sessions can never satisfy MFA-gated actions.
- **Partners.** `X-Pay2All-Merchant` is honoured only for API-partner keys, and only for merchants whose parent is that partner.
- **Idempotency.** `Idempotency-Key` is required on `POST /v1/payments`, `/v1/payouts` and `/v1/payments/:id/refunds`. See PAYIN_FLOW.md and PAYOUT_FLOW.md.

## 7. Webhook signing (Phase 7)

```
Pay2All-Event-Id:  evt_01J…
Pay2All-Signature: t=<unix seconds>,v1=hex(HMAC_SHA256(endpointSecret, `${t}.${rawBody}`))
```

- **Secrets.** Each endpoint has its own secret (`whsec_` + 32 random bytes), generated server-side and shown **once**, at creation or rotation. Delivery needs the raw secret, so it is stored AES-256-GCM encrypted with AAD bound to the endpoint id, not hashed. Responses and audit entries carry only a hint (`whsec_…abcd`).
- **Rotation.** The old secret keeps signing alongside the new one for 24 h, so the header carries `v1=…,v1=…`. The reference verifier accepts any `v1`.
- **Integrity.** The body (which contains the event id) and the timestamp are signed together. Receivers enforce a 5-minute tolerance and dedupe on the event id. The merchant guide with code samples is [WEBHOOKS.md](./WEBHOOKS.md).
- **SSRF protection (worker).**
  - Production requires `https` endpoints (`WEBHOOK_REQUIRE_HTTPS`).
  - At **every** delivery, all resolved addresses are checked against loopback, private, link-local (including `169.254.169.254`), CGNAT, multicast and reserved ranges, for IPv4, IPv6 and IPv4-mapped addresses. The socket connects to the **checked** address through a custom `lookup`, so DNS rebinding between check and connect is impossible.
  - IP-literal hosts are checked directly.
  - Redirects are never followed. Responses are read up to 1 KB, with a 10 s timeout.
  - `WEBHOOK_ALLOW_PRIVATE_TARGETS` exists for local development and is rejected at boot in production.
- **Notifications.** Emails can carry one-time links (password reset, invites). The API stores the rendered message encrypted (AAD = notification id), and the outbox / Kafka event carries only the notification id. The worker decrypts in memory, sends, and then wipes the ciphertext; failed messages are also wiped after the final attempt. Message bodies are never logged.

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
- **Chosen storage backends** (Settings → File Storage: S3, Google Drive, local disk) receive only ciphertext: each file is encrypted by the API with its own AES-256-GCM key, wrapped by the platform key (docs/FILE_STORAGE.md §2).
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

The following emit `security.*` events. They are audit rows today. Feeding them into the risk engine as rules is planned (SECURITY_REVIEW.md §3):

- refresh-token reuse
- login from a new IP or country for privileged roles
- repeated MFA failures
- lockouts
- an IP allowlist violation
- replayed signatures
- a mass export by one user
- a permission-denied burst

## 11. Row-level security (Phase 10)

The migration `…_risk_reports_observability` enables RLS on `payments`, `payouts`, `refunds` and `settlements`.

**Roles and policies:**
- **`pay2all_tenant_reader`** is a `NOLOGIN` role with `SELECT` on those four tables and on `organizations(id, parent_id)` only.
- **`tenant_scope` policies** read `pay2all.scope_kind` / `pay2all.scope_id`:
  - PLATFORM sees all rows.
  - MERCHANT sees its own rows.
  - RESELLER sees rows of merchants whose `organizations.parent_id` is the reseller or partner.
  - A refund is visible exactly when its payment is.
  - **Unset or unknown scope sees nothing** (fail closed).
- **`app_unrestricted`** keeps every other role, including the application role and migrations, unaffected. Enabling RLS therefore did not change any existing API path.

**How exports use it:** each batch runs in its own transaction:

```sql
SET LOCAL ROLE pay2all_tenant_reader;
SELECT set_config('pay2all.scope_kind', $kind, true), set_config('pay2all.scope_id', $id, true);
```

`LOCAL` settings end with the transaction, so the pooled connection returns unchanged.

**Tests:** `reports.e2e-spec.ts` shows that a query with no WHERE clause sees only the scoped tenant, that no scope sees nothing, that the reader cannot write or read the ledger, and that reseller scope equals its merchants.

**Production note:** the role that runs migrations must be allowed to `GRANT pay2all_tenant_reader TO` the runtime role. The migration grants it to `CURRENT_USER`; when migrations and runtime use different roles, add `GRANT pay2all_tenant_reader TO <runtime role>`.
