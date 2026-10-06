-- CreateEnum
CREATE TYPE "ApiEnvironment" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterEnum
ALTER TYPE "JournalType" ADD VALUE 'COMMISSION_PAYOUT';

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "environment" "ApiEnvironment" NOT NULL,
    "public_key" VARCHAR(60) NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "secret_last4" CHAR(4) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "permissions" TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 600,
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "last_used_ip" VARCHAR(64),
    "created_by_id" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" TEXT,
    "rotated_from_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_allowlist_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "environment" "ApiEnvironment" NOT NULL,
    "cidr" VARCHAR(64) NOT NULL,
    "label" VARCHAR(80),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_allowlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "api_key_id" TEXT,
    "partner_id" TEXT,
    "method" VARCHAR(8) NOT NULL,
    "path" VARCHAR(200) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "error_code" VARCHAR(60),
    "ip_address" VARCHAR(64),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_payouts" (
    "id" TEXT NOT NULL,
    "reseller_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "utr" VARCHAR(40) NOT NULL,
    "period_note" VARCHAR(120),
    "journal_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_public_key_key" ON "api_keys"("public_key");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_status_idx" ON "api_keys"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ip_allowlist_entries_organization_id_environment_cidr_key" ON "ip_allowlist_entries"("organization_id", "environment", "cidr");

-- CreateIndex
CREATE INDEX "api_request_logs_organization_id_created_at_idx" ON "api_request_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_request_logs_api_key_id_created_at_idx" ON "api_request_logs"("api_key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_request_logs_created_at_idx" ON "api_request_logs"("created_at");

-- CreateIndex
CREATE INDEX "commission_payouts_reseller_id_created_at_idx" ON "commission_payouts"("reseller_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "commission_payouts_reseller_id_utr_key" ON "commission_payouts"("reseller_id", "utr");

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_public_key_format" CHECK ("public_key" ~ '^pk_(test|live)_[A-Za-z0-9]{24,40}$');
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_env_prefix" CHECK (("environment" = 'TEST') = ("public_key" LIKE 'pk_test_%'));
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rate_limit" CHECK ("rate_limit_per_minute" BETWEEN 1 AND 100000);
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_amount" CHECK ("amount_minor" > 0);
CREATE TRIGGER commission_payouts_immutable BEFORE UPDATE OR DELETE ON "commission_payouts"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
