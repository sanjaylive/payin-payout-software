-- CreateEnum
CREATE TYPE "InboxCategory" AS ENUM ('PAYMENT', 'PAYOUT', 'SETTLEMENT', 'RISK', 'SECURITY', 'COMPLIANCE', 'WEBHOOK', 'REPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "InboxSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "inbox_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "category" "InboxCategory" NOT NULL,
    "severity" "InboxSeverity" NOT NULL DEFAULT 'INFO',
    "title" VARCHAR(140) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "link" VARCHAR(300),
    "resource_type" VARCHAR(40),
    "resource_id" VARCHAR(80),
    "dedupe_key" VARCHAR(160),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbox_notifications_user_id_created_at_id_idx" ON "inbox_notifications"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "inbox_notifications_user_id_read_at_idx" ON "inbox_notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "inbox_notifications_created_at_idx" ON "inbox_notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_notifications_user_id_dedupe_key_key" ON "inbox_notifications"("user_id", "dedupe_key");

-- Real-time push: NOTIFY is transactional — listeners hear it only after COMMIT, so a rolled-back
-- producer never shows a phantom notification. Payload is ids only (well under the 8 kB limit);
-- API nodes load the row before pushing it to the user's open tabs.
CREATE OR REPLACE FUNCTION inbox_notifications_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('inbox_notification', json_build_object('id', NEW.id, 'user_id', NEW.user_id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inbox_notifications_after_insert AFTER INSERT ON "inbox_notifications" FOR EACH ROW EXECUTE FUNCTION inbox_notifications_notify();

ALTER TABLE "inbox_notifications" ADD CONSTRAINT "inbox_notifications_link_internal" CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%'));
