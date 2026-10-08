-- A UTR can be claimed once, for ever: the partial index (pending / approved only) let a rejected or
-- cancelled claim free its UTR again. Replace it with a full unique index.
DROP INDEX "fund_requests_utr_live";
CREATE UNIQUE INDEX "fund_requests_utr_key" ON "fund_requests"("utr");
