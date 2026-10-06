-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('PAYIN', 'PAYOUT', 'BOTH');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'DOWN', 'MAINTENANCE', 'DISABLED');

-- CreateEnum
CREATE TYPE "StatusSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProviderEnvironment" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "RouteTier" AS ENUM ('PRIMARY', 'SECONDARY', 'FALLBACK');

-- CreateEnum
CREATE TYPE "InboundWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "adapter" VARCHAR(40) NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL DEFAULT 'TEST',
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_source" "StatusSource" NOT NULL DEFAULT 'MANUAL',
    "status_reason" VARCHAR(300),
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "costs" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "fingerprints" JSONB NOT NULL DEFAULT '{}',
    "rotated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_routes" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "service" "ServiceType" NOT NULL,
    "tier" "RouteTier" NOT NULL DEFAULT 'PRIMARY',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "provider_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "reseller_id" TEXT,
    "method" VARCHAR(30),
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "risk_categories" "RiskCategory"[],
    "time_window" JSONB,
    "created_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health_snapshots" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "requests" INTEGER NOT NULL,
    "successes" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "timeouts" INTEGER NOT NULL,
    "avg_latency_ms" INTEGER,
    "p95_latency_ms" INTEGER,
    "p99_latency_ms" INTEGER,
    "status" "ProviderStatus" NOT NULL,
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_webhook_events" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "external_event_id" VARCHAR(120) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboundWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" VARCHAR(500),
    "request_id" VARCHAR(40),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "providers_code_key" ON "providers"("code");

-- CreateIndex
CREATE INDEX "providers_kind_status_idx" ON "providers"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_provider_id_environment_key" ON "provider_credentials"("provider_id", "environment");

-- CreateIndex
CREATE INDEX "provider_routes_service_is_active_tier_priority_idx" ON "provider_routes"("service", "is_active", "tier", "priority");

-- CreateIndex
CREATE INDEX "provider_routes_merchant_id_idx" ON "provider_routes"("merchant_id");

-- CreateIndex
CREATE INDEX "provider_routes_reseller_id_idx" ON "provider_routes"("reseller_id");

-- CreateIndex
CREATE INDEX "provider_health_snapshots_provider_id_created_at_idx" ON "provider_health_snapshots"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "provider_webhook_events_status_received_at_idx" ON "provider_webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_webhook_events_provider_id_external_event_id_key" ON "provider_webhook_events"("provider_id", "external_event_id");

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_routes" ADD CONSTRAINT "provider_routes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_health_snapshots" ADD CONSTRAINT "provider_health_snapshots_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_webhook_events" ADD CONSTRAINT "provider_webhook_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards ------------------------------------------------------------------------------------------
ALTER TABLE "providers" ADD CONSTRAINT "providers_code_slug" CHECK ("code" ~ '^[a-z0-9][a-z0-9-]{1,39}$');
ALTER TABLE "provider_routes" ADD CONSTRAINT "provider_routes_amount_range" CHECK (
  ("min_amount_minor" IS NULL OR "min_amount_minor" >= 0) AND
  ("max_amount_minor" IS NULL OR "max_amount_minor" >= 0) AND
  ("min_amount_minor" IS NULL OR "max_amount_minor" IS NULL OR "min_amount_minor" <= "max_amount_minor"));
ALTER TABLE "provider_routes" ADD CONSTRAINT "provider_routes_service" CHECK ("service" IN ('PAYIN', 'PAYOUT'));
ALTER TABLE "provider_health_snapshots" ADD CONSTRAINT "provider_health_counts" CHECK (
  "requests" >= 0 AND "successes" >= 0 AND "failures" >= 0 AND "timeouts" >= 0);
