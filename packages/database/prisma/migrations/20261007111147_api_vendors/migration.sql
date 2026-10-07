-- CreateEnum
CREATE TYPE "ApiVendorStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MessagingServiceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'WHATSAPP';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "messaging_service_id" TEXT,
ADD COLUMN     "target_service_id" TEXT;

-- AlterTable
ALTER TABLE "providers" ADD COLUMN     "vendor_id" TEXT;

-- CreateTable
CREATE TABLE "api_vendors" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "ApiVendorStatus" NOT NULL DEFAULT 'ACTIVE',
    "website" VARCHAR(300),
    "contact_email" VARCHAR(254),
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_services" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "adapter" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "MessagingServiceStatus" NOT NULL DEFAULT 'DISABLED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_encrypted" TEXT,
    "fingerprints" JSONB NOT NULL DEFAULT '{}',
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messaging_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_vendors_code_key" ON "api_vendors"("code");

-- CreateIndex
CREATE INDEX "messaging_services_channel_status_priority_idx" ON "messaging_services"("channel", "status", "priority");

-- CreateIndex
CREATE INDEX "messaging_services_vendor_id_idx" ON "messaging_services"("vendor_id");

-- CreateIndex
CREATE INDEX "providers_vendor_id_idx" ON "providers"("vendor_id");

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "api_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging_services" ADD CONSTRAINT "messaging_services_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "api_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every existing payment provider becomes (or joins) a vendor. One vendor per provider for now;
-- admins merge them (e.g. one bank offering payin and payout) on the API Vendors screen.
INSERT INTO "api_vendors" ("id", "code", "name", "status", "updated_at")
SELECT 'avd_' || substr(p."id", 5), p."code", p."name", 'ACTIVE', now() FROM "providers" p
ON CONFLICT ("code") DO NOTHING;
UPDATE "providers" p SET "vendor_id" = v."id" FROM "api_vendors" v WHERE v."code" = p."code" AND p."vendor_id" IS NULL;
