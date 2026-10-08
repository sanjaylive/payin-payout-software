-- CreateEnum
CREATE TYPE "CollectionAccountKind" AS ENUM ('BANK', 'UPI');

-- CreateEnum
CREATE TYPE "FundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'FUND_REQUEST';

-- AlterEnum
ALTER TYPE "JournalType" ADD VALUE 'FUND_LOAD';

-- CreateTable
CREATE TABLE "collection_accounts" (
    "id" TEXT NOT NULL,
    "kind" "CollectionAccountKind" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "account_holder" VARCHAR(120),
    "account_number_encrypted" TEXT,
    "account_number_last4" CHAR(4),
    "ifsc" CHAR(11),
    "bank_name" VARCHAR(80),
    "branch" VARCHAR(120),
    "account_type" VARCHAR(10),
    "upi_id" VARCHAR(100),
    "payee_name" VARCHAR(100),
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "instructions" VARCHAR(300),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collection_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_requests" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "collection_account_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "utr" VARCHAR(30) NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "remarks" VARCHAR(300),
    "proof_key" VARCHAR(300),
    "proof_name" VARCHAR(160),
    "proof_type" VARCHAR(40),
    "status" "FundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "credited_amount_minor" BIGINT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(300),
    "journal_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_accounts_is_active_sort_order_idx" ON "collection_accounts"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "fund_requests_journal_id_key" ON "fund_requests"("journal_id");

-- CreateIndex
CREATE INDEX "fund_requests_status_created_at_idx" ON "fund_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "fund_requests_merchant_id_created_at_idx" ON "fund_requests"("merchant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "fund_requests" ADD CONSTRAINT "fund_requests_collection_account_id_fkey" FOREIGN KEY ("collection_account_id") REFERENCES "collection_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_shape" CHECK (
  ("kind" = 'BANK' AND "account_holder" IS NOT NULL AND "account_number_encrypted" IS NOT NULL AND "account_number_last4" IS NOT NULL AND "ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$' AND "upi_id" IS NULL)
  OR ("kind" = 'UPI' AND "upi_id" ~ '^[a-zA-Z0-9._-]{2,255}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$' AND "payee_name" IS NOT NULL AND "account_number_encrypted" IS NULL));
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_limits" CHECK (
  ("min_amount_minor" IS NULL OR "min_amount_minor" > 0) AND ("max_amount_minor" IS NULL OR "max_amount_minor" >= COALESCE("min_amount_minor", 1)));

ALTER TABLE "fund_requests" ADD CONSTRAINT "fund_requests_amount" CHECK ("amount_minor" > 0 AND ("credited_amount_minor" IS NULL OR "credited_amount_minor" > 0));
ALTER TABLE "fund_requests" ADD CONSTRAINT "fund_requests_mode" CHECK ("mode" IN ('UPI', 'IMPS', 'NEFT', 'RTGS', 'CASH_DEPOSIT', 'OTHER'));
ALTER TABLE "fund_requests" ADD CONSTRAINT "fund_requests_utr" CHECK ("utr" ~ '^[A-Z0-9]{6,30}$');
ALTER TABLE "fund_requests" ADD CONSTRAINT "fund_requests_decision" CHECK (
  ("status" = 'PENDING' AND "decided_at" IS NULL AND "journal_id" IS NULL)
  OR ("status" = 'APPROVED' AND "decided_at" IS NOT NULL AND "journal_id" IS NOT NULL AND "credited_amount_minor" IS NOT NULL)
  OR ("status" IN ('REJECTED', 'CANCELLED') AND "decided_at" IS NOT NULL AND "journal_id" IS NULL));
-- One payment reference can be claimed once (rejected / cancelled claims free it again).
CREATE UNIQUE INDEX "fund_requests_utr_live" ON "fund_requests" ("utr") WHERE "status" IN ('PENDING', 'APPROVED');
