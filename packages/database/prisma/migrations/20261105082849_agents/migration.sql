-- CreateEnum
CREATE TYPE "AgentPlanCode" AS ENUM ('FREE', 'STARTER', 'BUSINESS');

-- CreateEnum
CREATE TYPE "AgentBillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "AgentTxnType" AS ENUM ('MONEY_TRANSFER', 'CASH_WITHDRAWAL', 'CASH_DEPOSIT', 'BILL_PAYMENT', 'RECHARGE', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentTxnDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "AgentPayMode" AS ENUM ('CASH', 'UPI', 'BANK', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentTxnStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AgentIdType" AS ENUM ('AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentOrderStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentDriveStatus" AS ENUM ('CONNECTED', 'ERROR');

-- AlterEnum
ALTER TYPE "OrganizationType" ADD VALUE 'AGENT';

-- CreateTable
CREATE TABLE "agent_plans" (
    "id" TEXT NOT NULL,
    "code" "AgentPlanCode" NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(255) NOT NULL DEFAULT '',
    "price_monthly_minor" BIGINT NOT NULL DEFAULT 0,
    "price_yearly_minor" BIGINT NOT NULL DEFAULT 0,
    "monthly_txn_limit" INTEGER,
    "staff_limit" INTEGER NOT NULL DEFAULT 1,
    "drive_backup" BOOLEAN NOT NULL DEFAULT false,
    "branded_receipts" BOOLEAN NOT NULL DEFAULT false,
    "messaging" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_program_settings" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'default',
    "billing_merchant_id" TEXT,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_program_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "shop_name" VARCHAR(120) NOT NULL,
    "owner_name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(16) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "address_line" VARCHAR(255),
    "city" VARCHAR(80),
    "state" VARCHAR(80),
    "pincode" VARCHAR(6),
    "upi_vpa" VARCHAR(100),
    "upi_payee_name" VARCHAR(100),
    "qr_image_key" VARCHAR(255),
    "logo_key" VARCHAR(255),
    "receipt_footer" VARCHAR(200),
    "plan_id" TEXT NOT NULL,
    "plan_expires_at" TIMESTAMPTZ(3),
    "receipt_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_customers" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(16) NOT NULL,
    "email" VARCHAR(254),
    "address_line" VARCHAR(255),
    "city" VARCHAR(80),
    "pincode" VARCHAR(6),
    "date_of_birth" DATE,
    "id_type" "AgentIdType",
    "id_number_enc" TEXT,
    "id_number_last4" VARCHAR(4),
    "note" VARCHAR(255),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_beneficiaries" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "bank_name" VARCHAR(120),
    "account_number_enc" TEXT,
    "account_last4" VARCHAR(4),
    "ifsc" VARCHAR(11),
    "upi_id" VARCHAR(100),
    "relation" VARCHAR(40),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_transactions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "receipt_no" VARCHAR(20) NOT NULL,
    "receipt_token" VARCHAR(64) NOT NULL,
    "type" "AgentTxnType" NOT NULL,
    "direction" "AgentTxnDirection" NOT NULL,
    "mode" "AgentPayMode" NOT NULL,
    "status" "AgentTxnStatus" NOT NULL DEFAULT 'SUCCESS',
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "reference" VARCHAR(64),
    "description" VARCHAR(255),
    "customer_id" TEXT,
    "customer_name" VARCHAR(120),
    "customer_mobile" VARCHAR(16),
    "beneficiary_id" TEXT,
    "beneficiary_name" VARCHAR(120),
    "beneficiary_bank" VARCHAR(120),
    "beneficiary_account" VARCHAR(24),
    "beneficiary_ifsc" VARCHAR(11),
    "beneficiary_upi" VARCHAR(100),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_by_name" VARCHAR(120) NOT NULL,
    "status_note" VARCHAR(255),
    "status_changed_at" TIMESTAMPTZ(3),
    "receipt_sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_plan_orders" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "period" "AgentBillingPeriod" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "AgentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "checkout_session_id" TEXT,
    "checkout_url" VARCHAR(512),
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "granted_by_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_plan_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_drive_connections" (
    "agent_id" TEXT NOT NULL,
    "google_email" VARCHAR(254),
    "refresh_token_enc" TEXT NOT NULL,
    "folder_id" VARCHAR(128),
    "status" "AgentDriveStatus" NOT NULL DEFAULT 'CONNECTED',
    "auto_backup" BOOLEAN NOT NULL DEFAULT true,
    "last_backup_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(255),
    "connected_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_drive_connections_pkey" PRIMARY KEY ("agent_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_plans_code_key" ON "agent_plans"("code");

-- CreateIndex
CREATE INDEX "agent_profiles_plan_id_idx" ON "agent_profiles"("plan_id");

-- CreateIndex
CREATE INDEX "agent_customers_agent_id_created_at_idx" ON "agent_customers"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_customers_agent_id_mobile_key" ON "agent_customers"("agent_id", "mobile");

-- CreateIndex
CREATE INDEX "agent_beneficiaries_agent_id_customer_id_idx" ON "agent_beneficiaries"("agent_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_transactions_receipt_token_key" ON "agent_transactions"("receipt_token");

-- CreateIndex
CREATE INDEX "agent_transactions_agent_id_occurred_at_idx" ON "agent_transactions"("agent_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "agent_transactions_agent_id_customer_id_occurred_at_idx" ON "agent_transactions"("agent_id", "customer_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "agent_transactions_agent_id_created_at_idx" ON "agent_transactions"("agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_transactions_agent_id_receipt_no_key" ON "agent_transactions"("agent_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "agent_plan_orders_checkout_session_id_key" ON "agent_plan_orders"("checkout_session_id");

-- CreateIndex
CREATE INDEX "agent_plan_orders_agent_id_created_at_idx" ON "agent_plan_orders"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_plan_orders_status_created_at_idx" ON "agent_plan_orders"("status", "created_at");

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "agent_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_beneficiaries" ADD CONSTRAINT "agent_beneficiaries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "agent_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "agent_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "agent_beneficiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_plan_orders" ADD CONSTRAINT "agent_plan_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "agent_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ------------------------------------------------------------------------------------
ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_fee_non_negative" CHECK ("fee_minor" >= 0);
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_prices_non_negative" CHECK ("price_monthly_minor" >= 0 AND "price_yearly_minor" >= 0);
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_staff_limit_positive" CHECK ("staff_limit" >= 1);

-- Default plans (docs/AGENTS.md §2). Prices and limits are edited in Admin → Agents → Plans.
INSERT INTO "agent_plans" ("id", "code", "name", "description", "price_monthly_minor", "price_yearly_minor", "monthly_txn_limit", "staff_limit", "drive_backup", "branded_receipts", "messaging", "sort_order", "updated_at") VALUES
  ('apn_0000000000000000000000FREE', 'FREE', 'Free', 'Record up to 100 transactions a month', 0, 0, 100, 1, false, false, false, 1, now()),
  ('apn_0000000000000000000000STRT', 'STARTER', 'Starter', 'For a busy counter: more transactions, staff logins, branded receipts and Google Drive backup', 19900, 199900, 2000, 3, true, true, false, 2, now()),
  ('apn_0000000000000000000000BSNS', 'BUSINESS', 'Business', 'Unlimited transactions, more staff, SMS and WhatsApp receipts', 49900, 499900, NULL, 10, true, true, true, 3, now());

INSERT INTO "agent_program_settings" ("id", "updated_at") VALUES ('default', now());
