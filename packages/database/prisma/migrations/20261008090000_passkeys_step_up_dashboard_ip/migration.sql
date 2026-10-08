-- AlterEnum
ALTER TYPE "LoginOutcome" ADD VALUE 'IP_NOT_ALLOWED';

-- AlterEnum
ALTER TYPE "MfaFactorType" ADD VALUE 'PASSKEY';

-- AlterTable
ALTER TABLE "mfa_factors" ADD COLUMN     "credential_id" VARCHAR(1024),
ADD COLUMN     "last_used_at" TIMESTAMPTZ(3),
ADD COLUMN     "name" VARCHAR(60),
ADD COLUMN     "public_key" BYTEA,
ADD COLUMN     "sign_count" BIGINT,
ADD COLUMN     "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "secret_encrypted" DROP NOT NULL;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "reauthenticated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "dashboard_ip_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "cidr" VARCHAR(64) NOT NULL,
    "label" VARCHAR(80),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_ip_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_ip_rules_organization_id_cidr_key" ON "dashboard_ip_rules"("organization_id", "cidr");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_credential_id_key" ON "mfa_factors"("credential_id");

-- AddForeignKey
ALTER TABLE "dashboard_ip_rules" ADD CONSTRAINT "dashboard_ip_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A factor is either a TOTP secret or a passkey credential, never half of each.
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_kind_fields_check" CHECK (
  ("type"::text = 'TOTP' AND "secret_encrypted" IS NOT NULL AND "credential_id" IS NULL AND "public_key" IS NULL)
  OR ("type"::text = 'PASSKEY' AND "secret_encrypted" IS NULL AND "credential_id" IS NOT NULL AND "public_key" IS NOT NULL AND "sign_count" >= 0)
);

-- Dashboard allowlist entries are normalised CIDRs (validated in the API; shape guarded here).
ALTER TABLE "dashboard_ip_rules" ADD CONSTRAINT "dashboard_ip_rules_cidr_check" CHECK ("cidr" ~ '^[0-9a-fA-F:.]+/[0-9]{1,3}$');

-- Merchant owners and admins move money and manage keys: two-factor becomes mandatory for them
-- (docs/ROADMAP.md open decision 4). They are asked to enroll at their next sign-in.
UPDATE "roles" SET "requires_mfa" = true WHERE "organization_id" IS NULL AND "key" IN ('MERCHANT_OWNER', 'MERCHANT_ADMIN');
