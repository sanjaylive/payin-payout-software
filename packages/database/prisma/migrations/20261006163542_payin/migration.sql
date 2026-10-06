-- CreateEnum
CREATE TYPE "LateSuccessPolicy" AS ENUM ('AUTO_ACCEPT', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "PayinMethod" AS ENUM ('UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK', 'VIRTUAL_ACCOUNT', 'IMPS', 'NEFT', 'RTGS', 'CARD', 'NETBANKING');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'SETTLEMENT_PENDING', 'SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('INITIATED', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PricingPlanKind" AS ENUM ('PROVIDER_COST', 'WHOLESALE', 'MERCHANT');

-- CreateEnum
CREATE TYPE "PricingPlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('FLAT', 'PERCENTAGE', 'PERCENTAGE_WITH_MIN_MAX');

-- CreateEnum
CREATE TYPE "PricingSubjectType" AS ENUM ('MERCHANT', 'RESELLER', 'PROVIDER');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "late_success_policy" "LateSuccessPolicy" NOT NULL DEFAULT 'AUTO_ACCEPT';

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "reseller_id" TEXT,
    "merchant_order_id" VARCHAR(64) NOT NULL,
    "method" "PayinMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "net_amount_minor" BIGINT NOT NULL,
    "refunded_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "provider_id" TEXT,
    "route_id" TEXT,
    "provider_order_id" VARCHAR(120),
    "provider_transaction_id" VARCHAR(120),
    "utr" VARCHAR(40),
    "rrn" VARCHAR(40),
    "payer_vpa" VARCHAR(120),
    "customer_name" VARCHAR(120),
    "customer_mobile" VARCHAR(16),
    "customer_email" VARCHAR(254),
    "description" VARCHAR(200),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "qr_payload" VARCHAR(1000),
    "upi_intent" VARCHAR(1000),
    "payment_link" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "success_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_code" VARCHAR(60),
    "failure_reason" VARCHAR(300),
    "settled_at" TIMESTAMPTZ(3),
    "settlement_id" TEXT,
    "late_success" BOOLEAN NOT NULL DEFAULT false,
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" VARCHAR(300),
    "capture_journal_id" TEXT,
    "next_poll_at" TIMESTAMPTZ(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "request_id" VARCHAR(40),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider_id" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "provider_order_id" VARCHAR(120),
    "error_kind" VARCHAR(20),
    "error_code" VARCHAR(60),
    "error_message" VARCHAR(300),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "merchant_refund_id" VARCHAR(64),
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reason" VARCHAR(300),
    "status" "RefundStatus" NOT NULL DEFAULT 'CREATED',
    "provider_id" TEXT NOT NULL,
    "provider_refund_id" VARCHAR(120),
    "failure_reason" VARCHAR(300),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "journal_id" TEXT,
    "reversal_journal_id" TEXT,
    "created_by_id" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "request_method" VARCHAR(8) NOT NULL,
    "request_path" VARCHAR(200) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status_code" INTEGER,
    "response_body" JSONB,
    "resource_id" VARCHAR(60),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_plans" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "PricingPlanKind" NOT NULL,
    "status" "PricingPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "owner_org_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate_micros" BIGINT NOT NULL DEFAULT 18000000,
    "refund_fee" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "method" VARCHAR(30),
    "provider_id" TEXT,
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "charge_type" "ChargeType" NOT NULL,
    "rate_micros" BIGINT,
    "flat_minor" BIGINT,
    "min_fee_minor" BIGINT,
    "max_fee_minor" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_assignments" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "subject_type" "PricingSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_pricing_snapshots" (
    "id" TEXT NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "pricing" JSONB NOT NULL,
    "merchant_fee_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "tax_rate_micros" BIGINT NOT NULL,
    "wholesale_fee_minor" BIGINT,
    "provider_cost_minor" BIGINT NOT NULL,
    "reseller_margin_minor" BIGINT NOT NULL,
    "platform_margin_minor" BIGINT NOT NULL,
    "refund_fee" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pricing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "api_version" VARCHAR(20) NOT NULL DEFAULT '2026-10-01',
    "payload" JSONB NOT NULL,
    "resource_id" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_merchant_id_created_at_id_idx" ON "payments"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payments_reseller_id_created_at_idx" ON "payments"("reseller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "payments_provider_id_created_at_idx" ON "payments"("provider_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_created_at_id_idx" ON "payments"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_id_merchant_order_id_key" ON "payments"("merchant_id", "merchant_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_id_attempt_no_key" ON "payment_attempts"("payment_id", "attempt_no");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_merchant_id_created_at_id_idx" ON "refunds"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "refunds_status_next_attempt_at_idx" ON "refunds"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "refunds_created_at_id_idx" ON "refunds"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "idempotency_records_status_created_at_idx" ON "idempotency_records"("status", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_merchant_id_idempotency_key_key" ON "idempotency_records"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "pricing_plans_kind_status_is_default_idx" ON "pricing_plans"("kind", "status", "is_default");

-- CreateIndex
CREATE INDEX "pricing_rules_plan_id_service_idx" ON "pricing_rules"("plan_id", "service");

-- CreateIndex
CREATE INDEX "pricing_assignments_subject_type_subject_id_effective_from_idx" ON "pricing_assignments"("subject_type", "subject_id", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "transaction_pricing_snapshots_transaction_id_key" ON "transaction_pricing_snapshots"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_pricing_snapshots_merchant_id_created_at_idx" ON "transaction_pricing_snapshots"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_events_merchant_id_created_at_id_idx" ON "webhook_events"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "webhook_events_resource_id_idx" ON "webhook_events"("resource_id");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "pricing_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_assignments" ADD CONSTRAINT "pricing_assignments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "pricing_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts" CHECK (
  "amount_minor" > 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0 AND
  "net_amount_minor" = "amount_minor" - "fee_minor" - "tax_minor" AND "net_amount_minor" > 0 AND
  "refunded_amount_minor" >= 0 AND "refunded_amount_minor" <= "amount_minor");
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency" CHECK ("currency" = 'INR');
ALTER TABLE "payments" ADD CONSTRAINT "payments_version_positive" CHECK ("version" >= 1);
-- A provider's order id maps to exactly one payment (a callback can never touch two payments).
CREATE UNIQUE INDEX "payments_provider_order_unique" ON "payments" ("provider_id", "provider_order_id") WHERE "provider_order_id" IS NOT NULL;
CREATE INDEX "payments_utr" ON "payments" ("utr") WHERE "utr" IS NOT NULL;
CREATE INDEX "payments_rrn" ON "payments" ("rrn") WHERE "rrn" IS NOT NULL;
CREATE INDEX "payments_provider_txn" ON "payments" ("provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL;
-- Poller and expiry sweeper only scan open payments.
CREATE INDEX "payments_open_poll" ON "payments" ("next_poll_at") WHERE "status" IN ('CREATED', 'PENDING');
CREATE INDEX "payments_open_expiry" ON "payments" ("expires_at") WHERE "status" IN ('CREATED', 'PENDING');

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_minor" > 0);
CREATE UNIQUE INDEX "refunds_merchant_refund_id_unique" ON "refunds" ("merchant_id", "merchant_refund_id") WHERE "merchant_refund_id" IS NOT NULL;

ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_values" CHECK (
  ("rate_micros" IS NULL OR ("rate_micros" >= 0 AND "rate_micros" <= 100000000)) AND
  ("flat_minor" IS NULL OR "flat_minor" >= 0) AND
  ("min_fee_minor" IS NULL OR "min_fee_minor" >= 0) AND ("max_fee_minor" IS NULL OR "max_fee_minor" >= 0) AND
  ("min_fee_minor" IS NULL OR "max_fee_minor" IS NULL OR "min_fee_minor" <= "max_fee_minor") AND
  ("min_amount_minor" IS NULL OR "max_amount_minor" IS NULL OR "min_amount_minor" <= "max_amount_minor") AND
  ("charge_type" <> 'FLAT' OR "flat_minor" IS NOT NULL) AND
  ("charge_type" = 'FLAT' OR "rate_micros" IS NOT NULL));
ALTER TABLE "pricing_plans" ADD CONSTRAINT "pricing_plans_tax" CHECK ("tax_rate_micros" >= 0 AND "tax_rate_micros" <= 100000000);

-- Pricing snapshots and merchant-facing events are permanent records.
CREATE TRIGGER transaction_pricing_snapshots_immutable BEFORE UPDATE OR DELETE ON "transaction_pricing_snapshots"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
CREATE TRIGGER webhook_events_immutable BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
