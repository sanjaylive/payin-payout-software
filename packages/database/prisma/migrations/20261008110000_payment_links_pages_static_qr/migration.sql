-- CreateEnum
CREATE TYPE "CheckoutKind" AS ENUM ('CHECKOUT', 'LINK', 'PAGE');

-- CreateEnum
CREATE TYPE "PaymentPageStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PaymentPageAmountType" AS ENUM ('FIXED', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "StaticQrStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- AlterEnum
ALTER TYPE "PayinMethod" ADD VALUE 'UPI_STATIC_QR';

-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "kind" "CheckoutKind" NOT NULL DEFAULT 'CHECKOUT',
ADD COLUMN     "notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "page_id" TEXT,
ALTER COLUMN "return_url" DROP NOT NULL,
ALTER COLUMN "website_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "static_qr_id" TEXT;

-- CreateTable
CREATE TABLE "payment_pages" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "amount_type" "PaymentPageAmountType" NOT NULL,
    "amount_minor" BIGINT,
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "success_message" VARCHAR(300),
    "status" "PaymentPageStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "static_qrs" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_qr_id" VARCHAR(120) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "upi_payload" VARCHAR(1000),
    "image_url" VARCHAR(500),
    "status" "StaticQrStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_credit_at" TIMESTAMPTZ(3),
    "last_polled_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "static_qrs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_pages_slug_key" ON "payment_pages"("slug");

-- CreateIndex
CREATE INDEX "payment_pages_merchant_id_created_at_idx" ON "payment_pages"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "static_qrs_merchant_id_created_at_idx" ON "static_qrs"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "static_qrs_status_last_polled_at_idx" ON "static_qrs"("status", "last_polled_at");

-- CreateIndex
CREATE UNIQUE INDEX "static_qrs_provider_id_provider_qr_id_key" ON "static_qrs"("provider_id", "provider_qr_id");

-- CreateIndex
CREATE INDEX "checkout_sessions_merchant_id_kind_created_at_idx" ON "checkout_sessions"("merchant_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "checkout_sessions_page_id_created_at_idx" ON "checkout_sessions"("page_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_static_qr_id_created_at_idx" ON "payments"("static_qr_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_static_qr_id_fkey" FOREIGN KEY ("static_qr_id") REFERENCES "static_qrs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "payment_pages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "static_qrs" ADD CONSTRAINT "static_qrs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A website checkout always knows where to send the customer back; a link or page never does.
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_kind_fields" CHECK (
  ("kind" = 'CHECKOUT' AND "return_url" IS NOT NULL AND "website_id" IS NOT NULL AND "page_id" IS NULL)
  OR ("kind" = 'LINK' AND "return_url" IS NULL AND "website_id" IS NULL AND "page_id" IS NULL)
  OR ("kind" = 'PAGE' AND "return_url" IS NULL AND "website_id" IS NULL AND "page_id" IS NOT NULL)
);

ALTER TABLE "payment_pages" ADD CONSTRAINT "payment_pages_slug_format" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$');
ALTER TABLE "payment_pages" ADD CONSTRAINT "payment_pages_amounts" CHECK (
  ("amount_type" = 'FIXED' AND "amount_minor" >= 100 AND "min_amount_minor" IS NULL AND "max_amount_minor" IS NULL)
  OR ("amount_type" = 'CUSTOMER' AND "amount_minor" IS NULL AND "min_amount_minor" >= 100 AND "max_amount_minor" >= "min_amount_minor")
);
ALTER TABLE "payment_pages" ADD CONSTRAINT "payment_pages_fields_array" CHECK (jsonb_typeof("fields") = 'array' AND jsonb_array_length("fields") <= 5);

ALTER TABLE "static_qrs" ADD CONSTRAINT "static_qrs_upi" CHECK (("upi_payload" IS NULL OR "upi_payload" LIKE 'upi://pay?%') AND ("image_url" IS NULL OR "image_url" LIKE 'https://%') AND ("upi_payload" IS NOT NULL OR "image_url" IS NOT NULL));
ALTER TABLE "static_qrs" ADD CONSTRAINT "static_qrs_closed" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
-- Static-QR payments always name their QR.
ALTER TABLE "payments" ADD CONSTRAINT "payments_static_qr" CHECK (("method"::text = 'UPI_STATIC_QR') = ("static_qr_id" IS NOT NULL));
