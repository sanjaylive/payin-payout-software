-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST');

-- AlterEnum
ALTER TYPE "InboxCategory" ADD VALUE 'DISPUTE';

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider_case_id" VARCHAR(80),
    "reason_code" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "respond_by" TIMESTAMPTZ(3) NOT NULL,
    "payment_status_before" "PaymentStatus" NOT NULL,
    "lien_sources" JSONB NOT NULL,
    "lien_journal_id" TEXT NOT NULL,
    "outcome_journal_id" TEXT,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "merchant_note" VARCHAR(2000),
    "submitted_at" TIMESTAMPTZ(3),
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "resolution_note" VARCHAR(500),
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" TEXT NOT NULL,
    "dispute_id" TEXT NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "file_name" VARCHAR(160) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "description" VARCHAR(300),
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disputes_lien_journal_id_key" ON "disputes"("lien_journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_outcome_journal_id_key" ON "disputes"("outcome_journal_id");

-- CreateIndex
CREATE INDEX "disputes_merchant_id_created_at_idx" ON "disputes"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "disputes_status_respond_by_idx" ON "disputes"("status", "respond_by");

-- CreateIndex
CREATE INDEX "disputes_payment_id_idx" ON "disputes"("payment_id");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_created_at_idx" ON "dispute_evidence"("dispute_id", "created_at");

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "disputes" ADD CONSTRAINT "disputes_amount" CHECK ("amount_minor" > 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0);
-- Decided disputes have who/when and (always) an outcome journal; open ones have neither.
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolution" CHECK (
  ("status" IN ('WON', 'LOST')) = ("resolved_at" IS NOT NULL AND "outcome_journal_id" IS NOT NULL)
);
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_fee_only_when_lost" CHECK ("status" = 'LOST' OR ("fee_minor" = 0 AND "tax_minor" = 0));
-- At most one open dispute per payment.
CREATE UNIQUE INDEX "disputes_one_open_per_payment" ON "disputes" ("payment_id") WHERE "status" IN ('OPEN', 'UNDER_REVIEW');
