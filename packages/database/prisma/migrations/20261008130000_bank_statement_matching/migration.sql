-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'ALREADY_DECIDED', 'UNMATCHED');

-- CreateTable
CREATE TABLE "statement_imports" (
    "id" TEXT NOT NULL,
    "collection_account_id" TEXT NOT NULL,
    "file_name" VARCHAR(160) NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "credits" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL,
    "mismatched" INTEGER NOT NULL,
    "unmatched" INTEGER NOT NULL,
    "already_decided" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_lines" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "collection_account_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "value_date" TIMESTAMPTZ(3),
    "description" VARCHAR(300) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "utr" VARCHAR(30),
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "StatementLineStatus" NOT NULL,
    "fund_request_id" TEXT,
    "matched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statement_imports_created_at_idx" ON "statement_imports"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "statement_imports_collection_account_id_file_sha256_key" ON "statement_imports"("collection_account_id", "file_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "statement_lines_fund_request_id_key" ON "statement_lines"("fund_request_id");

-- CreateIndex
CREATE INDEX "statement_lines_import_id_line_no_idx" ON "statement_lines"("import_id", "line_no");

-- CreateIndex
CREATE INDEX "statement_lines_collection_account_id_status_idx" ON "statement_lines"("collection_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "statement_lines_collection_account_id_utr_key" ON "statement_lines"("collection_account_id", "utr");

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_collection_account_id_fkey" FOREIGN KEY ("collection_account_id") REFERENCES "collection_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "statement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_amount" CHECK ("amount_minor" > 0);
-- A matched line always names its fund request, and only matched lines do.
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_matched" CHECK ((("status" = 'MATCHED') = ("fund_request_id" IS NOT NULL AND "matched_at" IS NOT NULL)));
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_utr" CHECK ("utr" IS NULL OR "utr" ~ '^[A-Z0-9]{6,30}$');
-- Statement evidence is history: it's never edited or deleted, except to record a later match.
CREATE OR REPLACE FUNCTION statement_lines_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'statement_lines are append-only';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.utr IS DISTINCT FROM OLD.utr OR NEW.collection_account_id <> OLD.collection_account_id OR NEW.import_id <> OLD.import_id
     OR OLD.status NOT IN ('UNMATCHED') OR NEW.status NOT IN ('MATCHED', 'UNMATCHED') THEN
    RAISE EXCEPTION 'statement_lines: only an unmatched line can later be matched';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER statement_lines_guard BEFORE UPDATE OR DELETE ON "statement_lines" FOR EACH ROW EXECUTE FUNCTION statement_lines_guard();
