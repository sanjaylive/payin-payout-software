-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "content_encrypted" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer_group" VARCHAR(80) NOT NULL,
    "event_id" VARCHAR(60) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer_group","event_id")
);

-- CreateTable
CREATE TABLE "dead_letter_events" (
    "id" TEXT NOT NULL,
    "consumer_group" VARCHAR(80) NOT NULL,
    "topic" VARCHAR(120) NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset" VARCHAR(30) NOT NULL,
    "event_id" VARCHAR(60),
    "event_type" VARCHAR(80),
    "aggregate_id" VARCHAR(60),
    "error" VARCHAR(1000) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requeued_at" TIMESTAMPTZ(3),
    "requeued_by_id" TEXT,

    CONSTRAINT "dead_letter_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "description" VARCHAR(200),
    "secret_encrypted" TEXT NOT NULL,
    "secret_hint" VARCHAR(20) NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabled_reason" VARCHAR(300),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_status_code" INTEGER,
    "last_error" VARCHAR(500),
    "last_attempt_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery_attempts" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "error" VARCHAR(500),
    "response_snippet" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- CreateIndex
CREATE INDEX "dead_letter_events_requeued_at_created_at_idx" ON "dead_letter_events"("requeued_at", "created_at");

-- CreateIndex
CREATE INDEX "webhook_endpoints_merchant_id_status_idx" ON "webhook_endpoints"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_merchant_id_created_at_id_idx" ON "webhook_deliveries"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_event_id_endpoint_id_key" ON "webhook_deliveries"("event_id", "endpoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_attempts_delivery_id_attempt_no_key" ON "webhook_delivery_attempts"("delivery_id", "attempt_no");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
-- The relay scans only unpublished rows, oldest first.
CREATE INDEX IF NOT EXISTS "outbox_events_unpublished" ON "outbox_events" ("occurred_at", "id") WHERE "published_at" IS NULL;
-- Senders scan only due deliveries / notifications.
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" ("next_attempt_at") WHERE "status" = 'PENDING';
CREATE INDEX "notifications_due" ON "notifications" ("next_attempt_at") WHERE "status" = 'QUEUED';
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_url_scheme" CHECK ("url" ~ '^https?://');
-- Attempt logs and dead letters are records, not state.
CREATE TRIGGER webhook_delivery_attempts_immutable BEFORE UPDATE OR DELETE ON "webhook_delivery_attempts"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
