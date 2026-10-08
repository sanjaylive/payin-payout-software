# Database Architecture

PostgreSQL 17 · Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) · migrations in `packages/database/prisma/migrations`.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Primary keys | `TEXT` prefixed ULID, generated in the application: `org_`, `usr_`, `ses_`, `pay_`, `pout_`, `rfnd_`, `ben_`, `jrnl_`, `lent_`, `lacc_`, `stl_`, `evt_`, `whd_`, `aud_`, … (ADR-3). Monotonic ULIDs keep B-tree inserts mostly append-only. |
| Money | `BIGINT` **minor units** (paise), column suffix `Minor` (e.g. `amountMinor`). The `currency CHAR(3)` lives next to it. Never `float`, never `Decimal` for amounts. |
| Rates | `NUMERIC(12,6)` for percentages (`0.180000` = 0.18 %), and `BIGINT` minor units for flat fees. |
| Time | `TIMESTAMPTZ(3)`, always UTC. The UI converts to the viewer's timezone. |
| Table names | `snake_case` plural through `@@map`. Prisma model names are PascalCase singular. |
| Enums | Postgres enums for closed state sets (statuses). Adding a value is an online migration. |
| Soft delete | Not used for financial or compliance data. Records change status (e.g. `REVOKED`, `SUSPENDED`) and are never removed. |
| Tenant columns | Every tenant-owned row has `organizationId` or `merchantId`. Transactional rows also carry a denormalised `resellerId`. |
| Optimistic concurrency | Mutable aggregates with state machines (`payments`, `payouts`, `settlements`, `merchants`) have `version INT`. Transitions are conditional updates: `UPDATE … WHERE id = $1 AND status = $expected AND version = $v`. |
| Append-only tables | `audit_logs`, `ledger_entries`, `ledger_journals`, `compliance_reviews` and `transaction_pricing_snapshots` have `BEFORE UPDATE OR DELETE` triggers that raise an exception. |

## 2. Entity map by domain

### 2.1 Identity & access (Phase 1)

| Model | Purpose / key columns |
| --- | --- |
| `Organization` | Tenant root. `type` (PLATFORM/RESELLER/API_PARTNER/MERCHANT), `parentId`, `status`, `name`, `slug`. |
| `User` | `email` (citext-like unique lower), `mobile` (unique, E.164), `passwordHash` (argon2id), `status`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `passwordChangedAt`. |
| `Role` | `key` (e.g. `SUPER_ADMIN`), `scope` (org type it applies to), `organizationId` (null = system role), `requiresMfa`, `isSystem`. |
| `Permission` | `key` (`payout.approve`), `description`, `scope`. |
| `RolePermission` | role × permission (composite PK). |
| `UserRole` | Membership: user × role × organization (unique triple). `grantedById`, `createdAt`. |
| `Session` | One login. `userId`, `organizationId` (active org), `ip`, `userAgent`, `mfaVerifiedAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `revokedReason`. |
| `RefreshToken` | `tokenHash` (SHA-256, unique), `sessionId`, `expiresAt`, `usedAt`, `replacedById`. A reused token revokes the session. |
| `MfaFactor` | `type` (TOTP), `secretEncrypted` (AES-GCM envelope), `status` (PENDING/ACTIVE/DISABLED), `confirmedAt`, `lastUsedStep` (TOTP replay prevention). |
| `PasswordResetToken` | `tokenHash`, `userId`, `expiresAt`, `usedAt`, `requestedIp`. |
| `AuditLog` | Append-only. `actorId`, `actorRole`, `organizationId`, `action`, `resourceType`, `resourceId`, `oldValue` / `newValue` (JSONB, redacted), `ipAddress`, `userAgent`, `requestId`, `createdAt`. |
| `OutboxEvent` | `eventType`, `aggregateType`, `aggregateId`, `version`, `payload` (JSONB), `headers` (JSONB with request_id, trace), `occurredAt`, `publishedAt`, `attempts`, `lastError`. |
| `Notification` | `channel` (EMAIL/SMS), `template`, `recipient` (masked), `status`, `providerMessageId`, `requestId`. |

### 2.2 Merchant & compliance (Phase 2)

| Model | Key columns |
| --- | --- |
| `Merchant` | Shares its primary key with its `Organization` of type MERCHANT (`merchantId == organizationId`). `resellerId`, `status` (DRAFT → … → APPROVED/REJECTED/SUSPENDED), `payinEnabled`, `payoutEnabled`, `riskCategory`, `assignedSalesUserId`, `version`. |
| `MerchantProfile` | Legal name, display name, entity type, PAN, GSTIN, CIN/LLPIN, addresses (JSONB, validated), website, app URL, category, MCC, expected monthly volume, avg/max ticket (minor units), settlement preference, contacts. |
| `MerchantKyc` | Screening statuses (`sanctionsStatus`, `pepStatus`, `adverseMediaStatus`), `riskAssessment`, `kycStatus`. |
| `MerchantPerson` | Directors, partners, proprietors, UBOs and signatories in one table with role flags (one person often holds several roles). PAN is encrypted, masked and HMAC-indexed for cross-merchant matching. Also holds DIN, ownership % and KYC status. |
| `MerchantDocument` | `type`, `personId?`, `storageKey` (server-generated S3 key), `sha256` (computed server-side), `mimeType` (sniffed), `sizeBytes`, `status` (UPLOADED/VERIFIED/REJECTED/EXPIRED), `expiresAt`, `uploadedById`, `reviewedById`, `rejectionReason`. |
| `MerchantBankAccount` | `accountNumberEncrypted`, `accountNumberMasked`, `accountNumberHash` (HMAC, for duplicate detection across merchants), `ifsc`, `holderName`, `verificationStatus`, `isPrimary`. |
| `ComplianceReview` | Append-only, trigger-guarded history: `merchantId`, `action`, `fromStatus`, `toStatus`, `reviewedById`, `reviewedAt`, `reason`, `notes`, `details` (decision snapshot), `requestId`. |
| `SalesLead` | `assignedSalesUserId`, `source`, `status`, `followUpDate`, `notes` (append-only JSON log), `convertedMerchantId` (unique). Sales ownership of resellers and merchants is `Organization.assignedSalesUserId`. |
| `LimitConfig` | `level` (SYSTEM/RESELLER/MERCHANT), `subjectId`, `service` (PAYIN/PAYOUT), `perTxnMinMinor`, `perTxnMaxMinor`, `dailyAmountMinor`, `dailyCount`, `monthlyAmountMinor`, `monthlyCount`, `version`. Null fields inherit from the broader level, resolved field by field. Delegated admins can only tighten. |
| `ApprovalPolicy` | Maker-checker tiers per level: `[ {up_to_minor, approvals_required} ]`, plus `makerCheckerEnabled`. The most specific policy applies as a whole. A child policy can never be looser than its parent at any amount. |
| `MfaRecoveryCode` | `userId`, `codeHash` (keyed HMAC), `usedAt`. |

### 2.3 Ledger (Phase 3) — see LEDGER.md

| Model | Key columns |
| --- | --- |
| `LedgerAccount` | `code` (unique, e.g. `merchant:<id>:AVAILABLE`), `type` (ASSET/LIABILITY/REVENUE/EXPENSE/EQUITY/CLEARING), `normalBalance` (DEBIT/CREDIT), `ownerType` / `ownerId`, `bucket` (AVAILABLE/PENDING/UNSETTLED/SETTLED/RESERVED/LIEN, plus a per-merchant RECEIVABLE asset for chargeback/debit shortfalls), `currency`, `allowNegative`, `balanceMinor` (maintained running balance for lockable merchant accounts; NULL for hot platform accounts), `version`. |
| `LedgerJournal` | Immutable. `type` (PAYIN_CAPTURE, PAYOUT_RESERVE, PAYOUT_SETTLE, PAYOUT_RELEASE, REFUND, SETTLEMENT, ADJUSTMENT, REVERSAL, …), `sourceType` / `sourceId`, `idempotencyKey` (**unique**, prevents duplicate posting), `linesHash` (SHA-256 of canonical lines — a replay with the same key but different lines is rejected), `reversesJournalId`, `postedAt`, `requestId`, `createdById`. |
| `LedgerEntry` | Immutable. `journalId`, `accountId`, `direction` (DEBIT/CREDIT), `amountMinor` (> 0), `currency`, `balanceAfterMinor` (for maintained accounts). |
| `BalanceSnapshot` | Daily closing balance per account for fast historical statements and recon. |

### 2.4 Providers, routing, pricing (Phases 4–5)

| Model | Key columns |
| --- | --- |
| `Provider` | `code`, `kind` (PAYIN/PAYOUT/BOTH), `adapter` (mock/provider-a/…), `status` (ACTIVE/DEGRADED/DOWN/MAINTENANCE/DISABLED), `capabilities` (methods/modes). |
| `ProviderCredential` | `providerId`, `environment` (TEST/LIVE), `secretEncrypted`, `keyId`, `rotatedAt`. |
| `ProviderRoute` | `service`, `priority`, `tier` (PRIMARY/SECONDARY/FALLBACK), match criteria (`merchantId`, `resellerId`, `method`, `minAmountMinor`, `maxAmountMinor`, `riskCategory`, time window), `providerId`, `status`. |
| `ProviderHealth` | Windowed snapshot: success/failure/timeout rate, avg/p95/p99 latency, last success/failure. |
| `PricingPlan` | `ownerType` (PLATFORM/RESELLER), `name`, `status`, `effectiveFrom`, `effectiveTo`. |
| `PricingRule` | `planId`, `service`, `method`, `providerId?`, slab `minAmountMinor`/`maxAmountMinor`, `chargeType` (FLAT/PERCENTAGE/PERCENTAGE_WITH_MIN_MAX), `rate`, `flatMinor`, `minFeeMinor`, `maxFeeMinor`, `taxRate`. |
| `PricingAssignment` | Which plan applies to which merchant/reseller for which layer (`PROVIDER_COST`, `PLATFORM_TO_RESELLER`, `RESELLER_TO_MERCHANT`). |
| `TransactionPricingSnapshot` | Append-only. `transactionType`, `transactionId`, the full resolved rule set (JSONB), and the computed `providerCostMinor`, `platformFeeMinor`, `resellerFeeMinor`, `merchantFeeMinor`, `taxMinor`. Never recomputed. |

### 2.5 Payin / payout (Phases 5–6)

| Model | Key columns |
| --- | --- |
| `Payment` | `id` (`pay_`), `merchantId`, `resellerId`, `merchantOrderId`, `providerId`, `providerOrderId`, `providerTransactionId`, `utr`, `rrn`, `amountMinor`, `currency`, `feeMinor`, `taxMinor`, `netAmountMinor`, `method`, `status`, `customer` (JSONB, PII-minimised), `payerVpa`, `metadata`, `expiresAt`, `successAt`, `settledAt`, `settlementId`, `refundedAmountMinor`, `version`, timestamps. **Unique (`merchantId`, `merchantOrderId`).** |
| `PaymentAttempt` | Per provider attempt: `providerId`, `requestPayload` / `responsePayload` (redacted, truncated), `status`, `latencyMs`, `errorCode`. |
| `Refund` | `id` (`rfnd_`), `paymentId`, `merchantId`, `amountMinor`, `status`, `providerRefundId`, `reason`, `idempotencyKey`. |
| `Beneficiary` | `id` (`ben_`), `merchantId`, `name`, `type`, `accountNumberEncrypted`, `accountNumberMasked`, `accountNumberHash`, `ifsc`, `bankName`, `upiId`, `mobile`, `email`, `verificationStatus`, `verificationReference`. |
| `Payout` | `id` (`pout_`), `merchantId`, `resellerId`, `merchantOrderId`, `beneficiaryId`, beneficiary snapshot (masked), `mode`, `purpose`, `amountMinor`, `feeMinor`, `taxMinor`, `totalDebitMinor`, `status`, `providerId`, `providerReference`, `utr`, `failureCode`, `failureReason`, `createdById`, `approvalsRequired`, `approvalsReceived`, `reserveJournalId`, `finalJournalId`, `version`. **Unique (`merchantId`, `merchantOrderId`).** |
| `PayoutAttempt` | `payoutId`, `attemptNo`, `providerId`, `providerIdempotencyRef`, `status`, `latencyMs`, `request` / `response` (redacted). **Unique (`payoutId`, `attemptNo`).** |
| `PayoutApproval` | `payoutId`, `approverId`, `decision`, `comment`. **Unique (`payoutId`, `approverId`).** |
| `BulkPayoutBatch` | Uploaded file reference, row counts, status. Each row creates a normal `Payout` with its own idempotency key. |
| `IdempotencyRecord` | `merchantId`, `idempotencyKey`, `requestMethod`, `requestPath`, `requestHash` (SHA-256 of canonical body), `status` (IN_PROGRESS/COMPLETED), `responseStatusCode`, `responseBody`, `resourceId`, `expiresAt`. **Unique (`merchantId`, `idempotencyKey`).** |

### 2.6 Settlement, reconciliation, webhooks, API access, risk (Phases 7–10)

| Model | Key columns |
| --- | --- |
| `SettlementConfig` | `merchantId`, `cycle` (T0/T1/T2/CUSTOM), `cutoffTime`, `minAmountMinor`, `bankAccountId`, `holdReason?`. |
| `Settlement` | `id` (`stl_`), `merchantId`, `periodStart`, `periodEnd`, `grossMinor`, `refundMinor`, `chargebackMinor`, `feesMinor`, `taxMinor`, `adjustmentsMinor`, `netMinor`, `status`, `utr`, `bankReference`, `processedAt`, `journalId`. **Unique (`merchantId`, `periodStart`, `periodEnd`)** prevents double settlement. |
| `SettlementHold` | `merchantId`, `reason`, `placedById`, `releasedById`, `releasedAt`. |
| `ReconciliationRun` / `ReconciliationFile` / `ReconciliationEntry` | Run metadata. File (S3 key, sha256, parser). Entries with `source`, `internalRef`, `externalRef`, amounts, `status` (MATCHED/…/MANUAL_REVIEW), `resolvedById`, `resolution`. |
| `WebhookEndpoint` | `organizationId`, `url`, `secretEncrypted`, `events[]`, `status`. |
| `WebhookEvent` | `id` (`evt_`), `merchantId`, `type`, `payload`, `createdAt`. |
| `WebhookDelivery` | `eventId`, `endpointId`, `attempt`, `status`, `responseCode`, `responseBodyTruncated`, `latencyMs`, `nextRetryAt`. |
| `ApiKey` | `organizationId`, `environment` (TEST/LIVE), `publicKey` (`pk_live_…`, unique), `secretHash` (for lookup proof) **plus** `secretEncrypted` (needed to verify HMAC signatures — see SECURITY.md §6), `secretLast4`, `status`, `expiresAt`, `rotatedFromId`. |
| `IpWhitelist` | `organizationId`, `cidr`, `label`. |
| `ApiRequestLog` | Sampled/partitioned: key, path, status, latency, request_id (no bodies with PII). |
| `RiskRule` / `RiskEvent` / `RiskAction` | Rule definition (JSON DSL + thresholds), evaluated event with `explanation` JSONB (exact inputs that triggered), resulting action and actor. |
| `ProcessedEvent` | `(consumerGroup, eventId)` unique — consumer idempotency. |

## 3. State machines in the database

Allowed transitions are defined once in code (`packages/types` state tables) and enforced through conditional updates. For example, a payout moving to SUCCESS:

```sql
UPDATE payouts SET status = 'SUCCESS', version = version + 1, updated_at = now()
WHERE id = $1 AND status IN ('PROCESSING','PENDING') AND version = $2
RETURNING id;
```

Zero affected rows means a concurrent transition won. The caller re-reads the row and decides what to do, and never blindly overwrites.

## 4. Concurrency primitives

| Risk | Primary guard | Secondary guard |
| --- | --- | --- |
| Duplicate payin/payout on retry | `IdempotencyRecord` unique (merchant, key) | unique (merchant, merchantOrderId) |
| Double spend / double reservation | `SELECT … FOR UPDATE` on the merchant's AVAILABLE ledger account row inside the payout transaction | `CHECK (balance_minor >= 0)` on accounts with `allow_negative = false` |
| Duplicate ledger posting | `ledger_journals.idempotency_key` unique (e.g. `payout:pout_X:reserve`) | Journal-balance deferred constraint trigger |
| Double refund | lock the payment row; `refundedAmountMinor + amount <= amountMinor` checked under lock | unique refund idempotency key |
| Double settlement | unique (merchant, period) + payments claimed via `settlement_id IS NULL` conditional update | journal idempotency key `settlement:stl_X` |
| Concurrent state transition | `version` + expected-status conditional update | — |
| Duplicate consumer processing | `processed_events` unique | — |

Lock ordering: when several ledger accounts are locked in one transaction, lock them **sorted by account id** to rule out deadlocks.

## 5. Index plan (hot paths)

| Table | Index | Serves |
| --- | --- | --- |
| payments | `(merchant_id, created_at DESC, id DESC)` | merchant listing, keyset pagination |
| payments | `(reseller_id, created_at DESC)` | reseller listing |
| payments | `(status, created_at)` | ops queues, expiry sweeper |
| payments | `(provider_id, created_at)` | provider reports, recon |
| payments | unique `(merchant_id, merchant_order_id)` | dedupe + lookup by order id |
| payments | `(utr)`, `(rrn)`, `(provider_transaction_id)` — partial `WHERE … IS NOT NULL` | search, recon matching |
| payouts | same pattern as payments + `(beneficiary_id, created_at)` | beneficiary history, risk rules |
| ledger_entries | `(account_id, created_at, id)` | statements, balance rebuild |
| ledger_entries | `(journal_id)` | journal view |
| ledger_journals | unique `(idempotency_key)`, `(source_type, source_id)` | dedupe, drill-down |
| outbox_events | partial `(id) WHERE published_at IS NULL` | relay polling stays tiny |
| webhook_deliveries | `(status, next_retry_at)` partial on pending | retry scheduler |
| audit_logs | `(organization_id, created_at DESC)`, `(resource_type, resource_id)`, `(actor_id, created_at DESC)` | audit UI |
| idempotency_records | unique `(merchant_id, idempotency_key)`, `(expires_at)` | lookup, purge job |
| sessions | `(user_id, revoked_at)` | session list, logout-all |
| refresh_tokens | unique `(token_hash)`, `(session_id)` | refresh lookup |

Search by free text (customer name, VPA) goes through specific indexed columns only. There are no `ILIKE '%x%'` scans over transaction tables. Full-text search, if needed, moves to OpenSearch later.

## 6. Partitioning & archival (when volume warrants)

- At 1,000 TPS sustained, `payments` and `payouts` grow by tens of millions of rows a day, `ledger_entries` by 3–5× that.
- **Plan:** native range partitioning by month on `created_at` for `payments`, `payouts`, `ledger_entries`, `webhook_deliveries`, `api_request_logs` and `audit_logs`. PKs become `(id, created_at)` at that time. Because ULIDs embed the timestamp, `created_at` is derivable from the ID for routing lookups.
- Older partitions are detached to cheaper storage after the regulatory retention window. Retention values are config, set with legal and compliance input.
- Until then, single tables with the indexes above. Prisma models avoid features that conflict with partitioning, such as foreign keys *into* these hot tables from wide fan-out tables.

## 7. Migrations

- `prisma migrate dev` locally, and `prisma migrate deploy` in CI/CD (never `db push` outside throwaway dev).
- **Every deploy, after migrations:** `pnpm --filter @pay2all/database db:sync-rbac`. It makes permissions and system roles match `packages/auth`, so new permissions (e.g. `dispute.*`) reach existing roles. It creates no organizations, users or demo data and is safe in production; the demo seed is not.
- Hand-written SQL (triggers, partial indexes, CHECK constraints Prisma can't express) is appended to the generated migration file in the same migration, so schema and guards ship together.
- Zero-downtime discipline: expand → migrate data → contract. No destructive change ships in the same release as the code that stops using the column.
