-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY', 'CLEARING');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('PLATFORM', 'MERCHANT', 'RESELLER');

-- CreateEnum
CREATE TYPE "LedgerBucket" AS ENUM ('AVAILABLE', 'PENDING', 'UNSETTLED', 'SETTLED', 'RESERVED', 'LIEN', 'RECEIVABLE', 'COMMISSION_PAYABLE');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('PAYIN_CAPTURE', 'PROVIDER_SETTLEMENT', 'SETTLEMENT', 'HOLD_RELEASE', 'REFUND', 'REFUND_REVERSAL', 'CHARGEBACK_LIEN', 'CHARGEBACK_DEBIT', 'CHARGEBACK_RELEASE', 'PAYOUT_RESERVE', 'PAYOUT_SETTLE', 'PAYOUT_RELEASE', 'PAYOUT_REVERSAL', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'LIEN_PLACE', 'LIEN_RELEASE', 'COMMISSION_ACCRUAL', 'PROVIDER_CHARGE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('PAYMENT', 'PAYOUT', 'REFUND', 'SETTLEMENT', 'CHARGEBACK', 'ADJUSTMENT', 'PROVIDER', 'RISK', 'JOURNAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ServiceType" ADD VALUE 'ADJUSTMENT';

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "normal_balance" "EntryDirection" NOT NULL,
    "owner_type" "LedgerOwnerType" NOT NULL,
    "owner_id" TEXT,
    "bucket" "LedgerBucket",
    "currency" CHAR(3) NOT NULL,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "balance_minor" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_journals" (
    "id" TEXT NOT NULL,
    "type" "JournalType" NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "lines_hash" CHAR(64) NOT NULL,
    "source_type" "JournalSourceType" NOT NULL,
    "source_id" VARCHAR(60) NOT NULL,
    "reverses_journal_id" TEXT,
    "description" VARCHAR(300),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT,
    "request_id" VARCHAR(40),

    CONSTRAINT "ledger_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "journal_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balance_after_minor" BIGINT,
    "memo" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_snapshots" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "balance_minor" BIGINT NOT NULL,
    "debits_minor" BIGINT NOT NULL,
    "credits_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_adjustments" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "direction" "AdjustmentDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reason" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "supporting_note" VARCHAR(2000),
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvals_required" INTEGER NOT NULL,
    "maker_id" TEXT NOT NULL,
    "journal_id" TEXT,
    "rejected_by_id" TEXT,
    "rejection_reason" VARCHAR(500),
    "posted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_adjustment_approvals" (
    "id" TEXT NOT NULL,
    "adjustment_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "comment" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_adjustment_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_owner_type_owner_id_idx" ON "ledger_accounts"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "ledger_accounts_type_created_at_idx" ON "ledger_accounts"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journals_idempotency_key_key" ON "ledger_journals"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journals_reverses_journal_id_key" ON "ledger_journals"("reverses_journal_id");

-- CreateIndex
CREATE INDEX "ledger_journals_source_type_source_id_idx" ON "ledger_journals"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "ledger_journals_type_posted_at_idx" ON "ledger_journals"("type", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_journals_posted_at_id_idx" ON "ledger_journals"("posted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_created_at_id_idx" ON "ledger_entries"("account_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_journal_id_idx" ON "ledger_entries"("journal_id");

-- CreateIndex
CREATE INDEX "balance_snapshots_snapshot_date_idx" ON "balance_snapshots"("snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "balance_snapshots_account_id_snapshot_date_key" ON "balance_snapshots"("account_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_adjustments_journal_id_key" ON "ledger_adjustments"("journal_id");

-- CreateIndex
CREATE INDEX "ledger_adjustments_status_created_at_idx" ON "ledger_adjustments"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_adjustments_merchant_id_created_at_idx" ON "ledger_adjustments"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_adjustments_created_at_id_idx" ON "ledger_adjustments"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_adjustment_approvals_adjustment_id_approver_id_key" ON "ledger_adjustment_approvals"("adjustment_id", "approver_id");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "ledger_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_adjustment_approvals" ADD CONSTRAINT "ledger_adjustment_approvals_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "ledger_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Ledger guards (docs/LEDGER.md §1.1). Defence in depth: the app validates first; the database
-- refuses anything that slips through.
-- =============================================================================================

-- (a) Journals and entries are immutable (and can't be truncated).
CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON "ledger_journals"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();
CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON "ledger_journals"
  FOR EACH STATEMENT EXECUTE FUNCTION pay2all_forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION pay2all_forbid_mutation();

-- (b) Every journal balances per currency and has >= 2 lines — checked at COMMIT so lines can be
--     inserted in any order within the transaction.
CREATE OR REPLACE FUNCTION ledger_assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
  n integer;
BEGIN
  SELECT currency,
         SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) AS dr,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END) AS cr
    INTO bad
    FROM ledger_entries
   WHERE journal_id = NEW.journal_id
   GROUP BY currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % unbalanced in %: dr=% cr=%', NEW.journal_id, bad.currency, bad.dr, bad.cr
      USING ERRCODE = 'P0002';
  END IF;
  SELECT COUNT(*) INTO n FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % has fewer than 2 entries', NEW.journal_id USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced();

-- (c) An entry's currency must match its account's currency.
CREATE OR REPLACE FUNCTION ledger_assert_entry_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE id = NEW.account_id AND currency = NEW.currency) THEN
    RAISE EXCEPTION 'entry currency % does not match account %', NEW.currency, NEW.account_id USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_currency BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_currency();

-- (d) Account identity is fixed once created; only balance/version/metadata may change.
CREATE OR REPLACE FUNCTION ledger_account_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.type <> OLD.type OR NEW.normal_balance <> OLD.normal_balance
     OR NEW.owner_type <> OLD.owner_type OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.currency <> OLD.currency
     OR NEW.allow_negative <> OLD.allow_negative
     OR (OLD.balance_minor IS NULL) <> (NEW.balance_minor IS NULL) THEN
    RAISE EXCEPTION 'ledger account % identity is immutable', OLD.code USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_accounts_identity BEFORE UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION ledger_account_identity_immutable();
CREATE TRIGGER ledger_accounts_no_delete BEFORE DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();

-- (e) Row-level sanity.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_non_negative"
  CHECK ("allow_negative" OR "balance_minor" IS NULL OR "balance_minor" >= 0);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_not_self_reversal"
  CHECK ("reverses_journal_id" IS NULL OR "reverses_journal_id" <> "id");
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_approvals_range" CHECK ("approvals_required" BETWEEN 0 AND 3);

-- Approvals are an audit trail too.
CREATE TRIGGER ledger_adjustment_approvals_immutable BEFORE UPDATE OR DELETE ON "ledger_adjustment_approvals"
  FOR EACH ROW EXECUTE FUNCTION pay2all_forbid_mutation();

-- =============================================================================================
-- Shared read functions (used by the API on demand and by the worker's scheduled jobs).
-- =============================================================================================

-- Signed balance of an account from its entries, as of an optional cut-off.
CREATE OR REPLACE FUNCTION ledger_account_balances(p_cutoff timestamptz DEFAULT NULL)
RETURNS TABLE (account_id text, debits_minor numeric, credits_minor numeric, balance_minor numeric)
LANGUAGE sql STABLE AS $$
  SELECT a.id,
         COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0),
         COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0),
         CASE WHEN a.normal_balance = 'DEBIT'
              THEN COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)
              ELSE COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)
         END
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id AND (p_cutoff IS NULL OR e.created_at < p_cutoff)
   GROUP BY a.id, a.normal_balance;
$$;

-- Maintained accounts whose stored balance disagrees with their entries or last running balance.
CREATE OR REPLACE FUNCTION ledger_verify_balances()
RETURNS TABLE (account_id text, code text, owner_id text, stored_minor bigint, computed_minor numeric, last_balance_after_minor bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.code, a.owner_id, a.balance_minor, b.balance_minor,
         (SELECT e.balance_after_minor FROM ledger_entries e
           WHERE e.account_id = a.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1)
    FROM ledger_accounts a
    JOIN ledger_account_balances(NULL) b ON b.account_id = a.id
   WHERE a.balance_minor IS NOT NULL
     AND (a.balance_minor <> b.balance_minor
          OR a.balance_minor IS DISTINCT FROM COALESCE(
               (SELECT e.balance_after_minor FROM ledger_entries e
                 WHERE e.account_id = a.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1), 0));
$$;
