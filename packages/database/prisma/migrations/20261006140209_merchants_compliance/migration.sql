-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'ONE_PERSON_COMPANY', 'TRUST', 'SOCIETY', 'HUF', 'GOVERNMENT');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SettlementCycle" AS ENUM ('T0', 'T1', 'T2', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'CLEAR', 'MATCH_FOUND', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PAN', 'GST_CERTIFICATE', 'CIN_CERTIFICATE', 'ADDRESS_PROOF', 'BANK_PROOF', 'CANCELLED_CHEQUE', 'DIRECTOR_KYC', 'AGREEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('CURRENT', 'SAVINGS');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "ComplianceAction" AS ENUM ('CREATED', 'SUBMITTED', 'REVIEW_STARTED', 'INFORMATION_REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REACTIVATED');

-- CreateEnum
CREATE TYPE "LimitLevel" AS ENUM ('SYSTEM', 'RESELLER', 'MERCHANT');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PAYIN', 'PAYOUT');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "assigned_sales_user_id" TEXT,
ADD COLUMN     "source" VARCHAR(80);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "reseller_id" TEXT,
    "status" "MerchantStatus" NOT NULL DEFAULT 'DRAFT',
    "payin_enabled" BOOLEAN NOT NULL DEFAULT false,
    "payout_enabled" BOOLEAN NOT NULL DEFAULT false,
    "risk_category" "RiskCategory",
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_profiles" (
    "merchant_id" TEXT NOT NULL,
    "legal_name" VARCHAR(200),
    "display_name" VARCHAR(120),
    "entity_type" "EntityType",
    "pan" CHAR(10),
    "gstin" CHAR(15),
    "cin" CHAR(21),
    "llpin" VARCHAR(8),
    "registered_address" JSONB,
    "operational_address" JSONB,
    "website" VARCHAR(300),
    "app_url" VARCHAR(300),
    "business_category" VARCHAR(100),
    "mcc" CHAR(4),
    "business_description" VARCHAR(2000),
    "expected_monthly_volume_minor" BIGINT,
    "average_ticket_minor" BIGINT,
    "maximum_ticket_minor" BIGINT,
    "payin_required" BOOLEAN NOT NULL DEFAULT false,
    "payout_required" BOOLEAN NOT NULL DEFAULT false,
    "settlement_preference" "SettlementCycle",
    "contact_name" VARCHAR(120),
    "contact_email" VARCHAR(254),
    "contact_mobile" VARCHAR(16),
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_profiles_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "merchant_kyc" (
    "merchant_id" TEXT NOT NULL,
    "sanctions_status" "ScreeningStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "pep_status" "ScreeningStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "adverse_media_status" "ScreeningStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "screened_at" TIMESTAMPTZ(3),
    "screened_by_id" TEXT,
    "risk_notes" VARCHAR(2000),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_kyc_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "merchant_persons" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "designation" VARCHAR(80),
    "pan_encrypted" TEXT NOT NULL,
    "pan_masked" VARCHAR(10) NOT NULL,
    "pan_hash" CHAR(64) NOT NULL,
    "din" CHAR(8),
    "email" VARCHAR(254),
    "mobile" VARCHAR(16),
    "is_director" BOOLEAN NOT NULL DEFAULT false,
    "is_ubo" BOOLEAN NOT NULL DEFAULT false,
    "is_authorized_signatory" BOOLEAN NOT NULL DEFAULT false,
    "ownership_percent" DECIMAL(5,2),
    "kyc_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_documents" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "person_id" TEXT,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_name" VARCHAR(200) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "description" VARCHAR(200),
    "expires_at" DATE,
    "uploaded_by_id" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "rejection_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_bank_accounts" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "account_holder_name" VARCHAR(120) NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_masked" VARCHAR(18) NOT NULL,
    "account_number_hash" CHAR(64) NOT NULL,
    "ifsc" CHAR(11) NOT NULL,
    "bank_name" VARCHAR(120),
    "account_type" "BankAccountType" NOT NULL DEFAULT 'CURRENT',
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verification_reference" VARCHAR(100),
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_reviews" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "action" "ComplianceAction" NOT NULL,
    "from_status" "MerchantStatus",
    "to_status" "MerchantStatus" NOT NULL,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500),
    "notes" VARCHAR(4000),
    "details" JSONB,
    "request_id" VARCHAR(40),

    CONSTRAINT "compliance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "limit_configs" (
    "id" TEXT NOT NULL,
    "level" "LimitLevel" NOT NULL,
    "subject_id" TEXT,
    "service" "ServiceType" NOT NULL,
    "per_txn_min_minor" BIGINT,
    "per_txn_max_minor" BIGINT,
    "daily_amount_minor" BIGINT,
    "daily_count" INTEGER,
    "monthly_amount_minor" BIGINT,
    "monthly_count" INTEGER,
    "updated_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "limit_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" TEXT NOT NULL,
    "level" "LimitLevel" NOT NULL,
    "subject_id" TEXT,
    "service" "ServiceType" NOT NULL DEFAULT 'PAYOUT',
    "maker_checker_enabled" BOOLEAN NOT NULL DEFAULT true,
    "tiers" JSONB NOT NULL,
    "updated_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_leads" (
    "id" TEXT NOT NULL,
    "company_name" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(120) NOT NULL,
    "contact_email" VARCHAR(254),
    "contact_mobile" VARCHAR(16),
    "source" VARCHAR(80) NOT NULL,
    "expected_monthly_volume" VARCHAR(40),
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "assigned_sales_user_id" TEXT,
    "follow_up_date" DATE,
    "notes" JSONB NOT NULL DEFAULT '[]',
    "converted_merchant_id" TEXT,
    "converted_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx" ON "mfa_recovery_codes"("user_id", "used_at");

-- CreateIndex
CREATE INDEX "merchants_status_created_at_id_idx" ON "merchants"("status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "merchants_reseller_id_created_at_idx" ON "merchants"("reseller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "merchant_profiles_pan_idx" ON "merchant_profiles"("pan");

-- CreateIndex
CREATE INDEX "merchant_profiles_gstin_idx" ON "merchant_profiles"("gstin");

-- CreateIndex
CREATE INDEX "merchant_persons_merchant_id_idx" ON "merchant_persons"("merchant_id");

-- CreateIndex
CREATE INDEX "merchant_persons_pan_hash_idx" ON "merchant_persons"("pan_hash");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_documents_storage_key_key" ON "merchant_documents"("storage_key");

-- CreateIndex
CREATE INDEX "merchant_documents_merchant_id_type_created_at_idx" ON "merchant_documents"("merchant_id", "type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "merchant_documents_status_created_at_idx" ON "merchant_documents"("status", "created_at");

-- CreateIndex
CREATE INDEX "merchant_bank_accounts_merchant_id_is_active_idx" ON "merchant_bank_accounts"("merchant_id", "is_active");

-- CreateIndex
CREATE INDEX "merchant_bank_accounts_account_number_hash_idx" ON "merchant_bank_accounts"("account_number_hash");

-- CreateIndex
CREATE INDEX "compliance_reviews_merchant_id_reviewed_at_idx" ON "compliance_reviews"("merchant_id", "reviewed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "limit_configs_level_subject_id_service_key" ON "limit_configs"("level", "subject_id", "service");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policies_level_subject_id_service_key" ON "approval_policies"("level", "subject_id", "service");

-- CreateIndex
CREATE UNIQUE INDEX "sales_leads_converted_merchant_id_key" ON "sales_leads"("converted_merchant_id");

-- CreateIndex
CREATE INDEX "sales_leads_status_follow_up_date_idx" ON "sales_leads"("status", "follow_up_date");

-- CreateIndex
CREATE INDEX "sales_leads_assigned_sales_user_id_created_at_idx" ON "sales_leads"("assigned_sales_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sales_leads_created_at_id_idx" ON "sales_leads"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "organizations_assigned_sales_user_id_idx" ON "organizations"("assigned_sales_user_id");

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_id_fkey" FOREIGN KEY ("id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_kyc" ADD CONSTRAINT "merchant_kyc_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_persons" ADD CONSTRAINT "merchant_persons_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "merchant_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_bank_accounts" ADD CONSTRAINT "merchant_bank_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_reviews" ADD CONSTRAINT "compliance_reviews_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Hand-written guards and reference data (docs/DATABASE.md §1, §4).
-- =============================================================================================

-- Compliance history is append-only and must never be deleted.
CREATE TRIGGER compliance_reviews_immutable
  BEFORE UPDATE OR DELETE ON "compliance_reviews"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
CREATE TRIGGER compliance_reviews_no_truncate
  BEFORE TRUNCATE ON "compliance_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION pay2all_forbid_mutation();

-- Exactly one active primary settlement account per merchant.
CREATE UNIQUE INDEX "merchant_bank_accounts_one_primary"
  ON "merchant_bank_accounts" ("merchant_id") WHERE "is_primary" AND "is_active";
-- The same account can't be added twice (active) to one merchant.
CREATE UNIQUE INDEX "merchant_bank_accounts_unique_active_account"
  ON "merchant_bank_accounts" ("merchant_id", "account_number_hash") WHERE "is_active";

-- NULL subject ids are distinct in unique indexes, so SYSTEM rows need their own guard.
CREATE UNIQUE INDEX "limit_configs_system_unique" ON "limit_configs" ("service") WHERE "level" = 'SYSTEM';
CREATE UNIQUE INDEX "approval_policies_system_unique" ON "approval_policies" ("service") WHERE "level" = 'SYSTEM';
ALTER TABLE "limit_configs" ADD CONSTRAINT "limit_configs_subject_matches_level"
  CHECK (("level" = 'SYSTEM') = ("subject_id" IS NULL));
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_subject_matches_level"
  CHECK (("level" = 'SYSTEM') = ("subject_id" IS NULL));

-- Money and counts are never negative; min <= max.
ALTER TABLE "limit_configs" ADD CONSTRAINT "limit_configs_non_negative" CHECK (
  coalesce("per_txn_min_minor", 0) >= 0 AND coalesce("per_txn_max_minor", 0) >= 0 AND
  coalesce("daily_amount_minor", 0) >= 0 AND coalesce("monthly_amount_minor", 0) >= 0 AND
  coalesce("daily_count", 0) >= 0 AND coalesce("monthly_count", 0) >= 0);
ALTER TABLE "limit_configs" ADD CONSTRAINT "limit_configs_min_le_max" CHECK (
  "per_txn_min_minor" IS NULL OR "per_txn_max_minor" IS NULL OR "per_txn_min_minor" <= "per_txn_max_minor");
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_amounts_non_negative" CHECK (
  coalesce("expected_monthly_volume_minor", 0) >= 0 AND coalesce("average_ticket_minor", 0) >= 0 AND
  coalesce("maximum_ticket_minor", 0) >= 0);
ALTER TABLE "merchant_persons" ADD CONSTRAINT "merchant_persons_ownership_range" CHECK (
  "ownership_percent" IS NULL OR ("ownership_percent" >= 0 AND "ownership_percent" <= 100));
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_size_positive" CHECK ("size_bytes" > 0);
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_version_positive" CHECK ("version" >= 1);

-- Backfill: every existing MERCHANT organization gets its merchant aggregate in DRAFT.
INSERT INTO "merchants" ("id", "reseller_id", "status", "created_at", "updated_at")
SELECT o."id",
       CASE WHEN p."type" = 'RESELLER' THEN p."id" END,
       'DRAFT', o."created_at", now()
FROM "organizations" o
LEFT JOIN "organizations" p ON p."id" = o."parent_id"
WHERE o."type" = 'MERCHANT'
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "merchant_profiles" ("merchant_id", "display_name", "updated_at")
SELECT m."id", o."name", now() FROM "merchants" m JOIN "organizations" o ON o."id" = m."id"
ON CONFLICT ("merchant_id") DO NOTHING;
INSERT INTO "merchant_kyc" ("merchant_id", "updated_at") SELECT "id", now() FROM "merchants"
ON CONFLICT ("merchant_id") DO NOTHING;

-- System default limits (amounts in paise). Platform admins tune these; specific levels override.
INSERT INTO "limit_configs" ("id", "level", "subject_id", "service", "per_txn_min_minor", "per_txn_max_minor",
  "daily_amount_minor", "monthly_amount_minor", "updated_at") VALUES
  ('lim_01M48RC57SBBMS1N3QQK688E1K lim_01M48RC57SBBMS1N3QQK688E1M apl_01M48RC57TTCJCY15NENZHAVV2', 'SYSTEM', NULL, 'PAYIN',  100, 10000000, 100000000, 2000000000, now()),
  ('', 'SYSTEM', NULL, 'PAYOUT', 100, 20000000,  50000000, 1000000000, now());

-- System maker-checker policy from the product spec:
--   up to ₹10,000 → auto; ₹10,000.01–₹1,00,000 → one approver; above → two approvers.
INSERT INTO "approval_policies" ("id", "level", "subject_id", "service", "maker_checker_enabled", "tiers", "updated_at")
VALUES ('', 'SYSTEM', NULL, 'PAYOUT', true,
  '[{"up_to_minor":"1000000","approvals_required":0},{"up_to_minor":"10000000","approvals_required":1},{"up_to_minor":null,"approvals_required":2}]'::jsonb,
  now());
