-- CreateTable
CREATE TABLE "tax_profile" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "legal_name" VARCHAR(200) NOT NULL,
    "gstin" CHAR(15) NOT NULL,
    "pan" CHAR(10) NOT NULL,
    "address" VARCHAR(400) NOT NULL,
    "state_code" CHAR(2) NOT NULL,
    "sac" VARCHAR(8) NOT NULL,
    "invoice_prefix" VARCHAR(5) NOT NULL,
    "footer_note" VARCHAR(500),
    "updated_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "financial_year" VARCHAR(7) NOT NULL,
    "last_serial" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("financial_year")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "number" VARCHAR(16) NOT NULL,
    "financial_year" VARCHAR(7) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "issue_date" TIMESTAMPTZ(3) NOT NULL,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "place_of_supply" CHAR(2),
    "inter_state" BOOLEAN NOT NULL,
    "lines" JSONB NOT NULL,
    "taxable_minor" BIGINT NOT NULL,
    "cgst_minor" BIGINT NOT NULL,
    "sgst_minor" BIGINT NOT NULL,
    "igst_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "commission_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_period_start_merchant_id_idx" ON "invoices"("period_start", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_merchant_id_period_start_key" ON "invoices"("merchant_id", "period_start");


ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_single" CHECK ("id" = 'default');
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_state" CHECK ("state_code" = substr("gstin", 1, 2));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts" CHECK (
  "taxable_minor" >= 0 AND "cgst_minor" >= 0 AND "sgst_minor" >= 0 AND "igst_minor" >= 0 AND "commission_minor" >= 0
  AND "total_minor" = "taxable_minor" + "cgst_minor" + "sgst_minor" + "igst_minor"
  AND ("inter_state" OR "igst_minor" = 0) AND (NOT "inter_state" OR ("cgst_minor" = 0 AND "sgst_minor" = 0))
);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number" CHECK (char_length("number") <= 16 AND "number" ~ '^[A-Z0-9/-]+$');
-- Issued invoices are legal documents: never edited or deleted (corrections are credit notes).
CREATE OR REPLACE FUNCTION invoices_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoices are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION invoices_immutable();
