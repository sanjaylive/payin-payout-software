-- Smart routing policy per service (docs/ROUTING.md).
CREATE TYPE "RoutingStrategy" AS ENUM ('PRIORITY', 'SCORE');

CREATE TABLE "routing_policies" (
    "service" "ServiceType" NOT NULL,
    "strategy" "RoutingStrategy" NOT NULL DEFAULT 'PRIORITY',
    "window_minutes" INTEGER NOT NULL DEFAULT 60,
    "min_samples" INTEGER NOT NULL DEFAULT 20,
    "explore_percent" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "routing_policies_pkey" PRIMARY KEY ("service"),
    CONSTRAINT "routing_policies_service_check" CHECK ("service" IN ('PAYIN', 'PAYOUT')),
    CONSTRAINT "routing_policies_window_check" CHECK ("window_minutes" BETWEEN 5 AND 1440),
    CONSTRAINT "routing_policies_samples_check" CHECK ("min_samples" BETWEEN 1 AND 1000),
    CONSTRAINT "routing_policies_explore_check" CHECK ("explore_percent" BETWEEN 0 AND 20)
);

-- Conversion per provider and method over a recent window.
CREATE INDEX "payments_provider_id_method_created_at_idx" ON "payments" ("provider_id", "method", "created_at");
CREATE INDEX "payouts_provider_id_mode_created_at_idx" ON "payouts" ("provider_id", "mode", "created_at");
