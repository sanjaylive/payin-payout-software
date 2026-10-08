-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('OPEN', 'PAID', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "checkout_action" JSONB,
ADD COLUMN     "checkout_session_id" TEXT;

-- CreateTable
CREATE TABLE "merchant_websites" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "url" VARCHAR(300) NOT NULL,
    "label" VARCHAR(80),
    "status" "WebsiteStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(300),
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "merchant_order_id" VARCHAR(60) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "description" VARCHAR(200),
    "customer_name" VARCHAR(120),
    "customer_email" VARCHAR(254),
    "customer_mobile" VARCHAR(15),
    "return_url" VARCHAR(500) NOT NULL,
    "website_id" TEXT NOT NULL,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'OPEN',
    "payment_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_websites_status_created_at_idx" ON "merchant_websites"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_websites_merchant_id_url_key" ON "merchant_websites"("merchant_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_token_key" ON "checkout_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_payment_id_key" ON "checkout_sessions"("payment_id");

-- CreateIndex
CREATE INDEX "checkout_sessions_merchant_id_created_at_idx" ON "checkout_sessions"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "checkout_sessions_status_expires_at_idx" ON "checkout_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_merchant_id_merchant_order_id_key" ON "checkout_sessions"("merchant_id", "merchant_order_id");

-- CreateIndex
CREATE INDEX "payments_checkout_session_id_idx" ON "payments"("checkout_session_id");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "merchant_websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "merchant_websites" ADD CONSTRAINT "merchant_websites_origin" CHECK ("url" ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$');
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_amount" CHECK ("amount_minor" >= 100);
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_attempts" CHECK ("attempts" BETWEEN 0 AND 10);
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_paid" CHECK (("status" = 'PAID') = ("payment_id" IS NOT NULL AND "paid_at" IS NOT NULL));
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_order" CHECK ("merchant_order_id" ~ '^[A-Za-z0-9_/.:-]{1,60}$');
