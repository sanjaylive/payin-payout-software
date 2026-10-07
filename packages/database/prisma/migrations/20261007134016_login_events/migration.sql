-- CreateEnum
CREATE TYPE "LoginOutcome" AS ENUM ('SUCCESS', 'MFA_REQUIRED', 'MFA_FAILED', 'BAD_PASSWORD', 'LOCKED', 'DISABLED', 'NOT_ACTIVATED', 'NO_ACTIVE_ORGANIZATION', 'UNKNOWN_USER');

-- AlterEnum
ALTER TYPE "ReportType" ADD VALUE 'LOGIN_EVENTS';

-- AlterTable
ALTER TABLE "report_exports" ADD COLUMN     "notify_by_email" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "identifier_masked" VARCHAR(254) NOT NULL,
    "outcome" "LoginOutcome" NOT NULL,
    "mfa_used" BOOLEAN NOT NULL DEFAULT false,
    "session_id" TEXT,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "browser" VARCHAR(60),
    "os" VARCHAR(60),
    "device_type" VARCHAR(20),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "location_accuracy_m" INTEGER,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_events_organization_id_created_at_id_idx" ON "login_events"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "login_events_user_id_created_at_idx" ON "login_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_events_created_at_id_idx" ON "login_events"("created_at" DESC, "id" DESC);

ALTER TABLE "login_events" ADD CONSTRAINT "login_events_location_range" CHECK (
  (latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180));

-- Append-only, like audit_logs: a sign-in record is evidence.
CREATE OR REPLACE FUNCTION login_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'login_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER login_events_no_update BEFORE UPDATE OR DELETE ON "login_events" FOR EACH ROW EXECUTE FUNCTION login_events_immutable();

-- Report exports read it under the RLS reader role (docs/SECURITY.md §11).
GRANT SELECT ON login_events TO pay2all_tenant_reader;
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_unrestricted ON login_events FOR ALL TO PUBLIC
  USING (current_user <> 'pay2all_tenant_reader') WITH CHECK (current_user <> 'pay2all_tenant_reader');
CREATE POLICY tenant_scope ON login_events FOR SELECT TO pay2all_tenant_reader USING (
  CASE current_setting('pay2all.scope_kind', true)
    WHEN 'PLATFORM' THEN true
    WHEN 'MERCHANT' THEN organization_id = current_setting('pay2all.scope_id', true)
    WHEN 'RESELLER' THEN organization_id = current_setting('pay2all.scope_id', true)
      OR organization_id IN (SELECT o.id FROM organizations o WHERE o.parent_id = current_setting('pay2all.scope_id', true))
    ELSE false
  END
);
