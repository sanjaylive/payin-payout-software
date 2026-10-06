-- CreateEnum
CREATE TYPE "SettlementDestination" AS ENUM ('WALLET', 'BANK');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconKind" AS ENUM ('PAYIN', 'PAYOUT');

-- CreateEnum
CREATE TYPE "ReconRunStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconResult" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ReconResolution" AS ENUM ('NOT_REQUIRED', 'OPEN', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalType" ADD VALUE 'SETTLEMENT_TRANSFER';
ALTER TYPE "JournalType" ADD VALUE 'SETTLEMENT_PAID';
ALTER TYPE "JournalType" ADD VALUE 'SETTLEMENT_RETURN';

-- CreateTable
CREATE TABLE "settlement_configs" (
    "merchant_id" TEXT NOT NULL,
    "cycle" "SettlementCycle" NOT NULL DEFAULT 'T1',
    "custom_days" INTEGER,
    "cutoff_minute" INTEGER NOT NULL DEFAULT 1080,
    "min_amount_minor" BIGINT NOT NULL DEFAULT 100,
    "destination" "SettlementDestination" NOT NULL DEFAULT 'BANK',
    "auto_settle" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_configs_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "reseller_id" TEXT,
    "settlement_date" CHAR(10) NOT NULL,
    "cycle" "SettlementCycle" NOT NULL,
    "destination" "SettlementDestination" NOT NULL,
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "status" "SettlementStatus" NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "refund_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "bank_account_id" TEXT,
    "bank_snapshot" JSONB,
    "utr" VARCHAR(40),
    "bank_reference" VARCHAR(80),
    "failure_reason" VARCHAR(300),
    "journal_id" TEXT,
    "transfer_journal_id" TEXT,
    "paid_journal_id" TEXT,
    "return_journal_id" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "processed_by_id" TEXT,
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_holds" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "placed_by_id" TEXT,
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_by_id" TEXT,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" VARCHAR(300),

    CONSTRAINT "settlement_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_remittances" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "reference" VARCHAR(80) NOT NULL,
    "value_date" CHAR(10) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "cost_minor" BIGINT NOT NULL,
    "bank_ref" VARCHAR(40) NOT NULL,
    "journal_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "kind" "ReconKind" NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "file_hash" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "status" "ReconRunStatus" NOT NULL DEFAULT 'QUEUED',
    "period_from" TIMESTAMPTZ(3),
    "period_to" TIMESTAMPTZ(3),
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "missing_internal" INTEGER NOT NULL DEFAULT 0,
    "missing_provider" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(1000),
    "created_by_id" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_entries" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "line_no" INTEGER,
    "result" "ReconResult" NOT NULL,
    "external_ref" VARCHAR(120),
    "external_utr" VARCHAR(40),
    "external_amount_minor" BIGINT,
    "external_status" VARCHAR(30),
    "internal_type" VARCHAR(10),
    "internal_id" TEXT,
    "internal_amount_minor" BIGINT,
    "internal_status" VARCHAR(30),
    "resolution" "ReconResolution" NOT NULL,
    "resolution_note" VARCHAR(500),
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_merchant_id_created_at_id_idx" ON "settlements"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "settlements_status_created_at_idx" ON "settlements"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_merchant_id_settlement_date_key" ON "settlements"("merchant_id", "settlement_date");

-- CreateIndex
CREATE INDEX "settlement_holds_merchant_id_released_at_idx" ON "settlement_holds"("merchant_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_remittances_provider_id_reference_key" ON "provider_remittances"("provider_id", "reference");

-- CreateIndex
CREATE INDEX "reconciliation_runs_created_at_idx" ON "reconciliation_runs"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_provider_id_file_hash_key" ON "reconciliation_runs"("provider_id", "file_hash");

-- CreateIndex
CREATE INDEX "reconciliation_entries_run_id_result_idx" ON "reconciliation_entries"("run_id", "result");

-- CreateIndex
CREATE INDEX "reconciliation_entries_resolution_created_at_idx" ON "reconciliation_entries"("resolution", "created_at");

-- CreateIndex
CREATE INDEX "reconciliation_entries_internal_id_idx" ON "reconciliation_entries"("internal_id");

-- AddForeignKey
ALTER TABLE "reconciliation_entries" ADD CONSTRAINT "reconciliation_entries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_amounts" CHECK (
  "gross_minor" >= 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0 AND "refund_minor" >= 0 AND "net_minor" >= 0 AND "payment_count" >= 0);
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_date" CHECK ("settlement_date" ~ '^\d{4}-\d{2}-\d{2}$');
-- A processed bank settlement always has its bank proof and journals; a failed one its return journal.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_paid_proof" CHECK (
  "destination" <> 'BANK' OR "status" <> 'PROCESSED' OR "net_minor" = 0 OR ("utr" IS NOT NULL AND "paid_journal_id" IS NOT NULL));
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_failed_return" CHECK ("status" <> 'FAILED' OR "return_journal_id" IS NOT NULL);
ALTER TABLE "settlement_configs" ADD CONSTRAINT "settlement_configs_values" CHECK (
  "cutoff_minute" BETWEEN 0 AND 1439 AND "min_amount_minor" >= 0 AND
  ("cycle" <> 'CUSTOM' OR "custom_days" BETWEEN 3 AND 7));
ALTER TABLE "provider_remittances" ADD CONSTRAINT "provider_remittances_amounts" CHECK ("amount_minor" > 0 AND "cost_minor" >= 0);
-- Settlement generator scans only captured, not-yet-settled payments.
CREATE INDEX "payments_unsettled" ON "payments" ("merchant_id", "success_at") WHERE "settlement_id" IS NULL AND "capture_journal_id" IS NOT NULL;
CREATE INDEX "payments_settlement" ON "payments" ("settlement_id") WHERE "settlement_id" IS NOT NULL;
-- Remittances are posted records.
CREATE TRIGGER provider_remittances_immutable BEFORE UPDATE OR DELETE ON "provider_remittances"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
