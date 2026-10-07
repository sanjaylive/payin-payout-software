-- CreateTable
CREATE TABLE "merchant_period_usage" (
    "merchant_id" TEXT NOT NULL,
    "service" "ServiceType" NOT NULL,
    "period" VARCHAR(11) NOT NULL,
    "amount_minor" BIGINT NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_period_usage_pkey" PRIMARY KEY ("merchant_id","service","period")
);

-- CreateIndex
CREATE INDEX "merchant_period_usage_updated_at_idx" ON "merchant_period_usage"("updated_at");

ALTER TABLE "merchant_period_usage" ADD CONSTRAINT "merchant_period_usage_non_negative" CHECK ("amount_minor" >= 0 AND "count" >= 0);
ALTER TABLE "merchant_period_usage" ADD CONSTRAINT "merchant_period_usage_period_format" CHECK ("period" ~ '^(D\d{4}-\d{2}-\d{2}|M\d{4}-\d{2})$');

-- Backfill the current and recent periods from existing transactions (IST calendar), counting the
-- same statuses the limit checks always counted.
INSERT INTO "merchant_period_usage" ("merchant_id", "service", "period", "amount_minor", "count", "updated_at")
SELECT merchant_id, 'PAYIN', p, sum(amount_minor), count(*), now() FROM (
  SELECT merchant_id, amount_minor, 'D' || to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS p FROM payments
   WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED') AND created_at >= now() - interval '62 days'
  UNION ALL
  SELECT merchant_id, amount_minor, 'M' || to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') FROM payments
   WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED') AND created_at >= now() - interval '62 days'
) t GROUP BY merchant_id, p;

INSERT INTO "merchant_period_usage" ("merchant_id", "service", "period", "amount_minor", "count", "updated_at")
SELECT merchant_id, 'PAYOUT', p, sum(amount_minor), count(*), now() FROM (
  SELECT merchant_id, amount_minor, 'D' || to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS p FROM payouts
   WHERE status NOT IN ('FAILED', 'REJECTED') AND created_at >= now() - interval '62 days'
  UNION ALL
  SELECT merchant_id, amount_minor, 'M' || to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') FROM payouts
   WHERE status NOT IN ('FAILED', 'REJECTED') AND created_at >= now() - interval '62 days'
) t GROUP BY merchant_id, p;
