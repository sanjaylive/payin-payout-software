import { Prisma, type TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import type { ReportTypeValue } from '@pay2all/validation';
import type { CellValue } from './report-writer';

/** Tenant scope frozen on the export when it was requested. */
export interface ReportScope {
  kind: 'PLATFORM' | 'RESELLER' | 'MERCHANT';
  id: string | null;
}

export interface ReportFilters {
  from: string;
  to: string;
  status?: string;
  merchant_id?: string;
}

export interface Keyset {
  createdAt: Date;
  id: string;
}

export interface ReportDefinition {
  columns: (scope: ReportScope) => string[];
  fetch: (tx: TransactionClient, scope: ReportScope, f: ReportFilters, after: Keyset | null, limit: number) => Promise<Array<{ keyset: Keyset; cells: CellValue[] }>>;
}

const money = (v: bigint | null) => (v === null ? null : minorToMajorString(v));
/** IST calendar days → [start, end) instants. */
export function istRange(f: ReportFilters): { start: Date; end: Date } {
  const start = new Date(`${f.from}T00:00:00+05:30`);
  const end = new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000);
  return { start, end };
}

/**
 * Explicit tenant predicate. RLS enforces the same rule underneath (docs/SECURITY.md §9); keeping
 * both means a bug in either one alone cannot leak another tenant's rows.
 */
function tenantSql(scope: ReportScope, f: ReportFilters, alias: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const col = Prisma.raw(`${alias}.merchant_id`);
  if (scope.kind === 'MERCHANT') parts.push(Prisma.sql`${col} = ${scope.id}`);
  if (scope.kind === 'RESELLER') parts.push(Prisma.sql`${col} IN (SELECT o.id FROM organizations o WHERE o.parent_id = ${scope.id})`);
  if (f.merchant_id) parts.push(Prisma.sql`${col} = ${f.merchant_id}`);
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

function after(alias: string, k: Keyset | null): Prisma.Sql {
  if (!k) return Prisma.empty;
  return Prisma.sql`AND (${Prisma.raw(`${alias}.created_at`)}, ${Prisma.raw(`${alias}.id`)}) > (${k.createdAt}, ${k.id})`;
}

const status = (alias: string, f: ReportFilters) => (f.status ? Prisma.sql`AND ${Prisma.raw(`${alias}.status`)}::text = ${f.status}` : Prisma.empty);

export const REPORTS: Record<ReportTypeValue, ReportDefinition> = {
  PAYMENTS: {
    columns: (s) => [
      'payment_id', 'merchant_id', 'merchant_order_id', 'created_at', 'status', 'method', 'amount', 'fee', 'tax', 'net_amount', 'refunded_amount',
      'utr', 'rrn', 'success_at', 'failure_reason', 'settlement_id', ...(s.kind === 'PLATFORM' ? ['reseller_id', 'provider_id'] : []),
    ],
    async fetch(tx, scope, f, k, limit) {
      const { start, end } = istRange(f);
      // Customer contact details are deliberately not exported (data minimisation).
      const rows = await tx.$queryRaw<Array<Record<string, unknown> & { id: string; created_at: Date }>>`
        SELECT p.id, p.merchant_id, p.merchant_order_id, p.created_at, p.status::text AS status, p.method::text AS method, p.amount_minor, p.fee_minor, p.tax_minor,
               p.net_amount_minor, p.refunded_amount_minor, p.utr, p.rrn, p.success_at, p.failure_reason, p.settlement_id, p.reseller_id, p.provider_id
        FROM payments p
        WHERE p.created_at >= ${start} AND p.created_at < ${end} ${tenantSql(scope, f, 'p')} ${status('p', f)} ${after('p', k)}
        ORDER BY p.created_at, p.id LIMIT ${limit}`;
      return rows.map((r) => ({
        keyset: { createdAt: r.created_at, id: r.id },
        cells: [
          r.id, r.merchant_id as string, r.merchant_order_id as string, r.created_at, r.status as string, r.method as string,
          money(r.amount_minor as bigint), money(r.fee_minor as bigint), money(r.tax_minor as bigint), money(r.net_amount_minor as bigint), money(r.refunded_amount_minor as bigint),
          r.utr as string | null, r.rrn as string | null, r.success_at as Date | null, r.failure_reason as string | null, r.settlement_id as string | null,
          ...(scope.kind === 'PLATFORM' ? [r.reseller_id as string | null, r.provider_id as string | null] : []),
        ],
      }));
    },
  },
  REFUNDS: {
    columns: () => ['refund_id', 'payment_id', 'merchant_id', 'merchant_refund_id', 'created_at', 'status', 'amount', 'reason', 'completed_at', 'failure_reason'],
    async fetch(tx, scope, f, k, limit) {
      const { start, end } = istRange(f);
      const rows = await tx.$queryRaw<Array<Record<string, unknown> & { id: string; created_at: Date }>>`
        SELECT r.id, r.payment_id, r.merchant_id, r.merchant_refund_id, r.created_at, r.status::text AS status, r.amount_minor, r.reason, r.completed_at, r.failure_reason
        FROM refunds r
        WHERE r.created_at >= ${start} AND r.created_at < ${end} ${tenantSql(scope, f, 'r')} ${status('r', f)} ${after('r', k)}
        ORDER BY r.created_at, r.id LIMIT ${limit}`;
      return rows.map((r) => ({
        keyset: { createdAt: r.created_at, id: r.id },
        cells: [r.id, r.payment_id as string, r.merchant_id as string, r.merchant_refund_id as string | null, r.created_at, r.status as string, money(r.amount_minor as bigint), r.reason as string | null, r.completed_at as Date | null, r.failure_reason as string | null],
      }));
    },
  },
  PAYOUTS: {
    columns: () => [
      'payout_id', 'merchant_id', 'merchant_order_id', 'created_at', 'status', 'mode', 'purpose', 'amount', 'fee', 'tax', 'total_debit',
      'beneficiary_name', 'beneficiary_account', 'beneficiary_ifsc', 'beneficiary_upi', 'utr', 'processed_at', 'failure_reason',
    ],
    async fetch(tx, scope, f, k, limit) {
      const { start, end } = istRange(f);
      // Beneficiary columns come from the masked snapshot: the full account number is never exported.
      const rows = await tx.$queryRaw<Array<Record<string, unknown> & { id: string; created_at: Date }>>`
        SELECT p.id, p.merchant_id, p.merchant_order_id, p.created_at, p.status::text AS status, p.mode, p.purpose, p.amount_minor, p.fee_minor, p.tax_minor, p.total_debit_minor,
               p.beneficiary_snapshot->>'name' AS b_name, p.beneficiary_snapshot->>'account_number_masked' AS b_account, p.beneficiary_snapshot->>'ifsc' AS b_ifsc,
               p.beneficiary_snapshot->>'upi_id' AS b_upi, p.utr, p.processed_at, p.failure_reason
        FROM payouts p
        WHERE p.created_at >= ${start} AND p.created_at < ${end} ${tenantSql(scope, f, 'p')} ${status('p', f)} ${after('p', k)}
        ORDER BY p.created_at, p.id LIMIT ${limit}`;
      return rows.map((r) => ({
        keyset: { createdAt: r.created_at, id: r.id },
        cells: [
          r.id, r.merchant_id as string, r.merchant_order_id as string, r.created_at, r.status as string, r.mode as string, r.purpose as string,
          money(r.amount_minor as bigint), money(r.fee_minor as bigint), money(r.tax_minor as bigint), money(r.total_debit_minor as bigint),
          r.b_name as string | null, r.b_account as string | null, r.b_ifsc as string | null, r.b_upi as string | null, r.utr as string | null, r.processed_at as Date | null, r.failure_reason as string | null,
        ],
      }));
    },
  },
  SETTLEMENTS: {
    columns: () => ['settlement_id', 'merchant_id', 'settlement_date', 'status', 'destination', 'payment_count', 'gross', 'fee', 'tax', 'refunds', 'net', 'utr', 'processed_at', 'failure_reason'],
    async fetch(tx, scope, f, k, limit) {
      // Settlements are filtered by their settlement (IST business) date, ordered by creation.
      const rows = await tx.$queryRaw<Array<Record<string, unknown> & { id: string; created_at: Date }>>`
        SELECT s.id, s.merchant_id, s.settlement_date, s.status::text AS status, s.destination::text AS destination, s.payment_count, s.gross_minor, s.fee_minor, s.tax_minor,
               s.refund_minor, s.net_minor, s.utr, s.processed_at, s.failure_reason, s.created_at
        FROM settlements s
        WHERE s.settlement_date >= ${f.from} AND s.settlement_date <= ${f.to} ${tenantSql(scope, f, 's')} ${status('s', f)} ${after('s', k)}
        ORDER BY s.created_at, s.id LIMIT ${limit}`;
      return rows.map((r) => ({
        keyset: { createdAt: r.created_at, id: r.id },
        cells: [
          r.id, r.merchant_id as string, r.settlement_date as string, r.status as string, r.destination as string, r.payment_count as number,
          money(r.gross_minor as bigint), money(r.fee_minor as bigint), money(r.tax_minor as bigint), money(r.refund_minor as bigint), money(r.net_minor as bigint),
          r.utr as string | null, r.processed_at as Date | null, r.failure_reason as string | null,
        ],
      }));
    },
  },
};

/**
 * Run `work` as the RLS-restricted reader role with the export's tenant scope (docs/SECURITY.md §9).
 * SET LOCAL / set_config(..., true) last only for this transaction, so the pooled connection goes
 * back to the pool unchanged.
 */
export async function withTenantReader<T>(tx: TransactionClient, scope: ReportScope, work: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SET LOCAL ROLE pay2all_tenant_reader`;
  await tx.$queryRaw`SELECT set_config('pay2all.scope_kind', ${scope.kind}, true), set_config('pay2all.scope_id', ${scope.id ?? ''}, true)`;
  return work();
}
