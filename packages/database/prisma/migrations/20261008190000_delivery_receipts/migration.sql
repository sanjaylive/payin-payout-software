-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'BOUNCED', 'COMPLAINED');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "delivery_at" TIMESTAMPTZ(3),
ADD COLUMN     "delivery_detail" VARCHAR(300),
ADD COLUMN     "delivery_status" "DeliveryStatus";

-- CreateTable
CREATE TABLE "messaging_receipt_events" (
    "id" TEXT NOT NULL,
    "messaging_service_id" TEXT NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_receipt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" TEXT NOT NULL,
    "email_index" VARCHAR(128) NOT NULL,
    "masked" VARCHAR(254) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "detail" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messaging_receipt_events_received_at_idx" ON "messaging_receipt_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_receipt_events_messaging_service_id_external_id_key" ON "messaging_receipt_events"("messaging_service_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_email_index_key" ON "email_suppressions"("email_index");

-- CreateIndex
CREATE INDEX "notifications_messaging_service_id_provider_message_id_idx" ON "notifications"("messaging_service_id", "provider_message_id");


ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_reason" CHECK ("reason" IN ('BOUNCE', 'COMPLAINT', 'MANUAL'));
