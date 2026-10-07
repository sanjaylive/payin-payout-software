-- CreateEnum
CREATE TYPE "PayoutReviewKind" AS ENUM ('RISK', 'UNKNOWN_OUTCOME');

-- CreateEnum
CREATE TYPE "RiskRuleType" AS ENUM ('VELOCITY', 'AMOUNT_ANOMALY', 'NEW_MERCHANT_VOLUME', 'BENEFICIARY_FAN_IN', 'VOLUME_SPIKE', 'FAILED_ATTEMPTS', 'SHARED_BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "RiskService" AS ENUM ('PAYIN', 'PAYOUT');

-- CreateEnum
CREATE TYPE "RiskActionType" AS ENUM ('ALLOW', 'BLOCK', 'MANUAL_REVIEW', 'HOLD_SETTLEMENT', 'DISABLE_PAYIN', 'DISABLE_PAYOUT');

-- CreateEnum
CREATE TYPE "RiskRuleMode" AS ENUM ('ENFORCE', 'MONITOR');

-- CreateEnum
CREATE TYPE "RiskEventStatus" AS ENUM ('RECORDED', 'OPEN', 'CLEARED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('PAYMENTS', 'REFUNDS', 'PAYOUTS', 'SETTLEMENTS');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ReportExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- DropIndex
DROP INDEX "payouts_beneficiary_id_idx";

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "review_kind" "PayoutReviewKind";
UPDATE "payouts" SET "review_kind" = 'UNKNOWN_OUTCOME' WHERE "status" = 'MANUAL_REVIEW';

-- CreateTable
CREATE TABLE "risk_rules" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "type" "RiskRuleType" NOT NULL,
    "service" "RiskService" NOT NULL,
    "params" JSONB NOT NULL,
    "action" "RiskActionType" NOT NULL,
    "mode" "RiskRuleMode" NOT NULL DEFAULT 'MONITOR',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "risk_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_events" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_code" VARCHAR(60) NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "merchant_id" TEXT,
    "subject_type" VARCHAR(30) NOT NULL,
    "subject_id" VARCHAR(80) NOT NULL,
    "action" "RiskActionType" NOT NULL,
    "mode" "RiskRuleMode" NOT NULL,
    "enforced" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "RiskEventStatus" NOT NULL DEFAULT 'RECORDED',
    "dedupe_key" VARCHAR(200),
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_actions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "type" "RiskActionType" NOT NULL,
    "hold_id" TEXT,
    "previous_value" BOOLEAN,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lifted_by_id" TEXT,
    "lifted_at" TIMESTAMPTZ(3),
    "lift_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope_kind" VARCHAR(20) NOT NULL,
    "scope_id" TEXT,
    "type" "ReportType" NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
    "filters" JSONB NOT NULL,
    "status" "ReportExportStatus" NOT NULL DEFAULT 'QUEUED',
    "row_count" INTEGER,
    "file_size" BIGINT,
    "sha256" CHAR(64),
    "storage_key" VARCHAR(300),
    "error" VARCHAR(300),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by_id" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "risk_rules_code_key" ON "risk_rules"("code");

-- CreateIndex
CREATE INDEX "risk_rules_service_enabled_idx" ON "risk_rules"("service", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "risk_events_dedupe_key_key" ON "risk_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "risk_events_status_created_at_idx" ON "risk_events"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "risk_events_merchant_id_created_at_idx" ON "risk_events"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "risk_events_rule_id_created_at_idx" ON "risk_events"("rule_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "risk_events_created_at_id_idx" ON "risk_events"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "risk_events_subject_type_subject_id_idx" ON "risk_events"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "risk_actions_merchant_id_active_idx" ON "risk_actions"("merchant_id", "active");

-- CreateIndex
CREATE INDEX "risk_actions_active_created_at_idx" ON "risk_actions"("active", "created_at" DESC);

-- CreateIndex
CREATE INDEX "risk_actions_event_id_idx" ON "risk_actions"("event_id");

-- CreateIndex
CREATE INDEX "report_exports_organization_id_created_at_idx" ON "report_exports"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "report_exports_status_created_at_idx" ON "report_exports"("status", "created_at");

-- CreateIndex
CREATE INDEX "payouts_beneficiary_id_created_at_idx" ON "payouts"("beneficiary_id", "created_at");

-- CreateIndex
CREATE INDEX "payouts_reseller_id_created_at_idx" ON "payouts"("reseller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payouts_created_at_id_idx" ON "payouts"("created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "risk_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_actions" ADD CONSTRAINT "risk_actions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "risk_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---- Row-level security for tenant-scoped reads (docs/SECURITY.md §9) ----------------------------
-- Defence in depth for report exports. The exporter runs each batch inside a transaction that does
-- `SET LOCAL ROLE pay2all_tenant_reader` and sets pay2all.scope_kind / pay2all.scope_id; Postgres
-- then returns only that tenant's rows even if a query forgets its WHERE clause. Every other role
-- (the application role, migrations) keeps unrestricted access through `app_unrestricted`, so
-- enabling RLS here does not change the behaviour of the main API paths.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pay2all_tenant_reader') THEN
    CREATE ROLE pay2all_tenant_reader NOLOGIN NOINHERIT;
  END IF;
END
$$;
GRANT pay2all_tenant_reader TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO pay2all_tenant_reader;
GRANT SELECT ON payments, payouts, refunds, settlements TO pay2all_tenant_reader;
-- Resellers and API partners see the merchants directly under them (organizations.parent_id).
GRANT SELECT (id, parent_id) ON organizations TO pay2all_tenant_reader;

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_unrestricted ON payments FOR ALL TO PUBLIC
  USING (current_user <> 'pay2all_tenant_reader') WITH CHECK (current_user <> 'pay2all_tenant_reader');
CREATE POLICY app_unrestricted ON payouts FOR ALL TO PUBLIC
  USING (current_user <> 'pay2all_tenant_reader') WITH CHECK (current_user <> 'pay2all_tenant_reader');
CREATE POLICY app_unrestricted ON refunds FOR ALL TO PUBLIC
  USING (current_user <> 'pay2all_tenant_reader') WITH CHECK (current_user <> 'pay2all_tenant_reader');
CREATE POLICY app_unrestricted ON settlements FOR ALL TO PUBLIC
  USING (current_user <> 'pay2all_tenant_reader') WITH CHECK (current_user <> 'pay2all_tenant_reader');

-- Scope unset or unknown → no rows (fail closed).
CREATE POLICY tenant_scope ON payments FOR SELECT TO pay2all_tenant_reader USING (
  CASE current_setting('pay2all.scope_kind', true)
    WHEN 'PLATFORM' THEN true
    WHEN 'MERCHANT' THEN merchant_id = current_setting('pay2all.scope_id', true)
    WHEN 'RESELLER' THEN merchant_id IN (SELECT o.id FROM organizations o WHERE o.parent_id = current_setting('pay2all.scope_id', true))
    ELSE false
  END
);
CREATE POLICY tenant_scope ON payouts FOR SELECT TO pay2all_tenant_reader USING (
  CASE current_setting('pay2all.scope_kind', true)
    WHEN 'PLATFORM' THEN true
    WHEN 'MERCHANT' THEN merchant_id = current_setting('pay2all.scope_id', true)
    WHEN 'RESELLER' THEN merchant_id IN (SELECT o.id FROM organizations o WHERE o.parent_id = current_setting('pay2all.scope_id', true))
    ELSE false
  END
);
CREATE POLICY tenant_scope ON settlements FOR SELECT TO pay2all_tenant_reader USING (
  CASE current_setting('pay2all.scope_kind', true)
    WHEN 'PLATFORM' THEN true
    WHEN 'MERCHANT' THEN merchant_id = current_setting('pay2all.scope_id', true)
    WHEN 'RESELLER' THEN merchant_id IN (SELECT o.id FROM organizations o WHERE o.parent_id = current_setting('pay2all.scope_id', true))
    ELSE false
  END
);
-- A refund is visible exactly when its payment is (the subquery is itself subject to RLS).
CREATE POLICY tenant_scope ON refunds FOR SELECT TO pay2all_tenant_reader USING (
  EXISTS (SELECT 1 FROM payments p WHERE p.id = refunds.payment_id)
);
