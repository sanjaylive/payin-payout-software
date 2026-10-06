-- CreateEnum
CREATE TYPE "BeneficiaryType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "BeneficiaryVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('CREATED', 'VALIDATING', 'APPROVAL_PENDING', 'MANUAL_REVIEW', 'QUEUED', 'PROCESSING', 'PENDING', 'SUCCESS', 'FAILED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PayoutSource" AS ENUM ('DASHBOARD', 'API', 'BULK');

-- CreateEnum
CREATE TYPE "PayoutAttemptStatus" AS ENUM ('INITIATED', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BulkBatchStatus" AS ENUM ('VALIDATED', 'VALIDATION_FAILED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BulkRowStatus" AS ENUM ('VALID', 'INVALID', 'CREATED', 'FAILED');

-- CreateTable
CREATE TABLE "beneficiaries" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "BeneficiaryType" NOT NULL DEFAULT 'INDIVIDUAL',
    "account_number_encrypted" TEXT,
    "account_number_masked" VARCHAR(40),
    "account_number_hash" VARCHAR(64),
    "ifsc" VARCHAR(11),
    "bank_name" VARCHAR(120),
    "upi_id" VARCHAR(255),
    "mobile" VARCHAR(20),
    "email" VARCHAR(254),
    "verification_status" "BeneficiaryVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verification_reference" VARCHAR(120),
    "verified_name" VARCHAR(160),
    "name_match_score" INTEGER,
    "verified_at" TIMESTAMPTZ(3),
    "verification_failure" VARCHAR(300),
    "blocked_reason" VARCHAR(300),
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "reseller_id" TEXT,
    "merchant_order_id" VARCHAR(64) NOT NULL,
    "mode" VARCHAR(10) NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'CREATED',
    "source" "PayoutSource" NOT NULL DEFAULT 'DASHBOARD',
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_debit_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "beneficiary_id" TEXT NOT NULL,
    "beneficiary_snapshot" JSONB NOT NULL,
    "narration" VARCHAR(100),
    "metadata" JSONB,
    "approvals_required" INTEGER NOT NULL DEFAULT 0,
    "approvals_received" INTEGER NOT NULL DEFAULT 0,
    "approval_expires_at" TIMESTAMPTZ(3),
    "provider_id" TEXT,
    "route_id" TEXT,
    "provider_reference" VARCHAR(120),
    "utr" VARCHAR(40),
    "failure_code" VARCHAR(60),
    "failure_reason" VARCHAR(300),
    "review_reason" VARCHAR(300),
    "reserve_journal_id" TEXT,
    "settle_journal_id" TEXT,
    "release_journal_id" TEXT,
    "reversal_journal_id" TEXT,
    "queued_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "reversed_at" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "requeue_count" INTEGER NOT NULL DEFAULT 0,
    "bulk_batch_id" TEXT,
    "bulk_row_no" INTEGER,
    "created_by_id" TEXT,
    "request_id" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider_id" TEXT NOT NULL,
    "reference" VARCHAR(60) NOT NULL,
    "provider_reference" VARCHAR(120),
    "status" "PayoutAttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "error_kind" VARCHAR(20),
    "error_code" VARCHAR(60),
    "error_message" VARCHAR(300),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_approvals" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_payout_batches" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "file_hash" VARCHAR(64) NOT NULL,
    "status" "BulkBatchStatus" NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "valid_rows" INTEGER NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "batch_approvals" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bulk_payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_payout_rows" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "row_no" INTEGER NOT NULL,
    "merchant_order_id" VARCHAR(64),
    "amount_minor" BIGINT,
    "mode" VARCHAR(10),
    "purpose" VARCHAR(30),
    "narration" VARCHAR(100),
    "beneficiary_id" TEXT,
    "beneficiary_label" VARCHAR(200),
    "status" "BulkRowStatus" NOT NULL,
    "errors" JSONB,
    "payout_id" TEXT,

    CONSTRAINT "bulk_payout_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "beneficiaries_merchant_id_created_at_id_idx" ON "beneficiaries"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "beneficiaries_account_number_hash_idx" ON "beneficiaries"("account_number_hash");

-- CreateIndex
CREATE INDEX "payouts_merchant_id_created_at_id_idx" ON "payouts"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");

-- CreateIndex
CREATE INDEX "payouts_beneficiary_id_idx" ON "payouts"("beneficiary_id");

-- CreateIndex
CREATE INDEX "payouts_bulk_batch_id_idx" ON "payouts"("bulk_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_merchant_id_merchant_order_id_key" ON "payouts"("merchant_id", "merchant_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_reference_key" ON "payout_attempts"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_payout_id_attempt_no_key" ON "payout_attempts"("payout_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payout_approvals_payout_id_approver_id_key" ON "payout_approvals"("payout_id", "approver_id");

-- CreateIndex
CREATE INDEX "bulk_payout_batches_merchant_id_created_at_idx" ON "bulk_payout_batches"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "bulk_payout_batches_merchant_id_file_hash_key" ON "bulk_payout_batches"("merchant_id", "file_hash");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_payout_rows_batch_id_row_no_key" ON "bulk_payout_rows"("batch_id", "row_no");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_approvals" ADD CONSTRAINT "payout_approvals_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_payout_rows" ADD CONSTRAINT "bulk_payout_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bulk_payout_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amounts" CHECK (
  "amount_minor" > 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0 AND
  "total_debit_minor" = "amount_minor" + "fee_minor" + "tax_minor");
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_currency" CHECK ("currency" = 'INR');
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_mode" CHECK ("mode" IN ('IMPS', 'NEFT', 'RTGS', 'UPI'));
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approvals" CHECK (
  "approvals_required" >= 0 AND "approvals_received" >= 0 AND "approvals_received" <= "approvals_required");
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_version_positive" CHECK ("version" >= 1);
-- A reserved payout always has its reservation journal.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reserved" CHECK ("status" IN ('CREATED', 'VALIDATING') OR "reserve_journal_id" IS NOT NULL);
CREATE UNIQUE INDEX "payouts_provider_reference_unique" ON "payouts" ("provider_id", "provider_reference") WHERE "provider_reference" IS NOT NULL;
CREATE INDEX "payouts_utr" ON "payouts" ("utr") WHERE "utr" IS NOT NULL;
-- Job scans touch only live payouts.
CREATE INDEX "payouts_due" ON "payouts" ("next_attempt_at") WHERE "status" IN ('QUEUED', 'PROCESSING', 'PENDING');
CREATE INDEX "payouts_approval_expiry" ON "payouts" ("approval_expires_at") WHERE "status" = 'APPROVAL_PENDING';
CREATE UNIQUE INDEX "payouts_bulk_row_unique" ON "payouts" ("bulk_batch_id", "bulk_row_no") WHERE "bulk_batch_id" IS NOT NULL;

-- A merchant has one beneficiary per destination (inline beneficiaries are upserted on this).
CREATE UNIQUE INDEX "beneficiaries_account_unique" ON "beneficiaries" ("merchant_id", "account_number_hash", "ifsc") WHERE "account_number_hash" IS NOT NULL;
CREATE UNIQUE INDEX "beneficiaries_upi_unique" ON "beneficiaries" ("merchant_id", lower("upi_id")) WHERE "upi_id" IS NOT NULL AND "account_number_hash" IS NULL;
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_destination" CHECK (
  ("account_number_encrypted" IS NOT NULL AND "account_number_hash" IS NOT NULL AND "ifsc" IS NOT NULL) OR "upi_id" IS NOT NULL);

-- Approval votes are a permanent audit trail.
CREATE TRIGGER payout_approvals_immutable BEFORE UPDATE OR DELETE ON "payout_approvals"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
