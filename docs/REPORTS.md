# Report exports

Large exports never run inside an HTTP request. A request creates a `report_exports` row. The jobs process generates the file in the background, and the dashboard polls until it can be downloaded.

Code: `apps/api/src/modules/reports/`. Tests: `apps/api/test/reports.e2e-spec.ts`.

## 1. Flow

1. `POST /v1/reports/exports` needs `report.export`. The body is `{ type, from, to, status?, merchant_id? }`; dates are IST calendar days, inclusive, at most 92 days. The caller's **tenant scope is frozen on the row**: PLATFORM, RESELLER (resellers and API partners) or MERCHANT. A `merchant_id` must lie inside that scope (404 otherwise). Each organization may have at most 3 exports in progress (429).
2. **Generation, in the jobs process every 10s:**
   - Claim with `FOR UPDATE SKIP LOCKED`.
   - Read rows in keyset batches of 5,000 ordered by `(created_at, id)`.
   - Run each batch in its own short transaction under the row-level-security reader role (§4).
   - Stream rows through the writer into an S3 multipart upload. Memory stays flat regardless of size.
   - Record the row count, size and SHA-256.
3. **Download:** `GET /v1/reports/exports/:id/download` streams the file through the API. Only the requesting organization can download it, and every download is audited. There are no public or pre-signed URLs.
4. **Retention:** completed files are kept 7 days, then the file is deleted and the export marked `EXPIRED`.

**Failures and limits:**
- A generation failure is retried up to 3 times. An export stuck in RUNNING for 30 minutes is re-queued.
- Exports above **1,000,000 rows** fail with a request to choose a shorter range.

## 2. Reports

| Type | Rows | Filter date |
| --- | --- | --- |
| `PAYMENTS` | Payins: ids, order id, status, method, amount, fee, tax, net, refunded, UTR/RRN, settlement. Platform exports also include `reseller_id` and `provider_id`. | `created_at` (IST) |
| `REFUNDS` | Refunds | `created_at` |
| `PAYOUTS` | Payouts, with the **masked** beneficiary snapshot (never the full account number). | `created_at` |
| `SETTLEMENTS` | Settlements: gross, fee, tax, refunds, net, UTR. | `settlement_date` |

Customer contact details (name, mobile, email, VPA) are not exported. This is data minimisation: reconciliation needs order ids and UTRs, not PII.

## 3. Format

- **CSV:** RFC 4180, UTF-8 with a BOM (so Excel shows ₹ and Indic names correctly), CRLF line endings. Amounts are rupee strings.
- **Spreadsheet formula injection:** cells starting with `= + - @`, tab or CR get a leading apostrophe.
- **Adding XLSX:** the generator only talks to the `ReportWriter` interface (`writeHeader / writeRow / end / stream`). XLSX needs a streaming workbook writer that implements the interface, a `writerFor('XLSX')` case, and the API's `format` enum widened. The enum value already exists in the schema and is rejected by validation until then.

## 4. Tenant isolation

Each batch query is filtered by tenant twice:
1. an explicit `merchant_id` predicate built from the frozen scope; and
2. Postgres row-level security under the `pay2all_tenant_reader` role (SECURITY.md §11).

A bug in either alone cannot leak another tenant's rows. The tests prove the second net on its own: a query with **no** tenant filter run under the reader role returns only the scoped merchant's rows, and returns nothing at all when no scope is set.
