-- CreateEnum
CREATE TYPE "SchemeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SchemeValueType" AS ENUM ('FLAT', 'PERCENT');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "scheme_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "commission_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "commission_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "commission_clawback_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transaction_pricing_snapshots" ADD COLUMN     "merchant_commission_minor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pricing_providers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "service" "ServiceType" NOT NULL,
    "methods" TEXT[],
    "description" VARCHAR(300),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schemes" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "status" "SchemeStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate_micros" BIGINT NOT NULL DEFAULT 18000000,
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_rates" (
    "id" TEXT NOT NULL,
    "scheme_id" TEXT NOT NULL,
    "provider_id" INTEGER NOT NULL,
    "min_amount_minor" BIGINT NOT NULL,
    "max_amount_minor" BIGINT,
    "value_type" "SchemeValueType" NOT NULL,
    "value" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schemes_status_idx" ON "schemes"("status");

-- CreateIndex
CREATE INDEX "scheme_rates_scheme_id_provider_id_idx" ON "scheme_rates"("scheme_id", "provider_id");

-- CreateIndex
CREATE INDEX "scheme_rates_provider_id_idx" ON "scheme_rates"("provider_id");

-- CreateIndex
CREATE INDEX "merchants_scheme_id_idx" ON "merchants"("scheme_id");

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_rates" ADD CONSTRAINT "scheme_rates_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_rates" ADD CONSTRAINT "scheme_rates_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "pricing_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
-- A transaction is either charged a fee or credited a commission, never both.
ALTER TABLE "payments" DROP CONSTRAINT "payments_amounts";
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts" CHECK (
  "amount_minor" > 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0 AND "commission_minor" >= 0 AND
  NOT ("fee_minor" > 0 AND "commission_minor" > 0) AND
  "net_amount_minor" = "amount_minor" - "fee_minor" - "tax_minor" + "commission_minor" AND "net_amount_minor" > 0 AND
  "refunded_amount_minor" >= 0 AND "refunded_amount_minor" <= "amount_minor");
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_amounts";
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amounts" CHECK (
  "amount_minor" > 0 AND "fee_minor" >= 0 AND "tax_minor" >= 0 AND "commission_minor" >= 0 AND
  NOT ("fee_minor" > 0 AND "commission_minor" > 0) AND
  "total_debit_minor" = "amount_minor" + "fee_minor" + "tax_minor" - "commission_minor" AND "total_debit_minor" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_commission_clawback" CHECK ("commission_clawback_minor" >= 0);
ALTER TABLE "transaction_pricing_snapshots" ADD CONSTRAINT "tps_merchant_commission" CHECK ("merchant_commission_minor" >= 0);

ALTER TABLE "pricing_providers" ADD CONSTRAINT "pricing_providers_service" CHECK ("service" IN ('PAYIN', 'PAYOUT'));
ALTER TABLE "pricing_providers" ADD CONSTRAINT "pricing_providers_methods" CHECK (cardinality("methods") BETWEEN 1 AND 12);
CREATE UNIQUE INDEX "pricing_providers_name_key" ON "pricing_providers" (lower("name"));

CREATE UNIQUE INDEX "schemes_one_default" ON "schemes" ((true)) WHERE "is_default" AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "schemes_active_name_key" ON "schemes" (lower("name")) WHERE "status" = 'ACTIVE';
ALTER TABLE "schemes" ADD CONSTRAINT "schemes_default_active" CHECK (NOT "is_default" OR "status" = 'ACTIVE');
ALTER TABLE "schemes" ADD CONSTRAINT "schemes_tax_rate" CHECK ("tax_rate_micros" BETWEEN 0 AND 100000000);

ALTER TABLE "scheme_rates" ADD CONSTRAINT "scheme_rates_slab" CHECK (
  "min_amount_minor" >= 0 AND ("max_amount_minor" IS NULL OR "max_amount_minor" >= "min_amount_minor"));
-- Percent values are capped at ±100 %; flat at ±₹1,00,000.
ALTER TABLE "scheme_rates" ADD CONSTRAINT "scheme_rates_value" CHECK (
  ("value_type" = 'PERCENT' AND "value" BETWEEN -100000000 AND 100000000) OR
  ("value_type" = 'FLAT' AND "value" BETWEEN -10000000 AND 10000000));

-- The standard pricing lines. More are added in Settings → Pricing Providers.
INSERT INTO "pricing_providers" ("id", "name", "service", "methods", "description", "updated_at") VALUES
  (1, 'Payout', 'PAYOUT', ARRAY['IMPS', 'NEFT', 'RTGS', 'UPI'], 'Bank and UPI payouts', CURRENT_TIMESTAMP),
  (2, 'Dynamic QR', 'PAYIN', ARRAY['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK'], 'Per-order UPI QR, intent and payment links', CURRENT_TIMESTAMP),
  (3, 'Static QR', 'PAYIN', ARRAY['UPI_STATIC_QR'], 'Fixed merchant QR collections', CURRENT_TIMESTAMP);
SELECT setval(pg_get_serial_sequence('pricing_providers', 'id'), 3);
