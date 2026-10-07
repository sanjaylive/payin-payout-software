-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "commission_accrued_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "commission_accrued_at" TIMESTAMPTZ(3);

-- ---- Index review (docs/perf/INDEX_REVIEW.md) ---------------------------------------------------

-- Commission accrual previously re-scanned every reseller transaction ever captured (NOT EXISTS
-- against ledger_journals) once a minute. A marker column plus a partial index that only holds
-- not-yet-accrued rows keeps the sweep proportional to the backlog, not to history.
UPDATE "payments" p SET "commission_accrued_at" = j."posted_at"
  FROM "ledger_journals" j WHERE j."idempotency_key" = 'commission:' || p."id";
UPDATE "payouts" o SET "commission_accrued_at" = j."posted_at"
  FROM "ledger_journals" j WHERE j."idempotency_key" = 'commission:' || o."id";
CREATE INDEX "payments_commission_due" ON "payments" ("created_at")
  WHERE "reseller_id" IS NOT NULL AND "capture_journal_id" IS NOT NULL AND "commission_accrued_at" IS NULL;
CREATE INDEX "payouts_commission_due" ON "payouts" ("created_at")
  WHERE "reseller_id" IS NOT NULL AND "settle_journal_id" IS NOT NULL AND "commission_accrued_at" IS NULL;

-- Risk fan-in looks up a UPI ID across all merchants (the existing unique index is per merchant).
CREATE INDEX "beneficiaries_upi_lookup" ON "beneficiaries" (lower("upi_id")) WHERE "upi_id" IS NOT NULL;

-- Settlement lists for resellers filter on reseller_id.
CREATE INDEX "settlements_reseller_id_created_at_idx" ON "settlements" ("reseller_id", "created_at" DESC) WHERE "reseller_id" IS NOT NULL;

-- Report exports and risk sweeps read refunds by time window.
-- (refunds_created_at_id_idx already exists; nothing to add.)
