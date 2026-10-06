-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "previous_secret_encrypted" TEXT,
ADD COLUMN     "previous_secret_expires_at" TIMESTAMPTZ(3);
