import { parseMajorToMinor } from '@pay2all/ledger';
import { parseCsv, RECON_CSV_REQUIRED } from '@pay2all/validation';

/** One normalised provider statement row. */
export interface StatementRow {
  lineNo: number;
  reference: string;
  providerTxnId: string | null;
  utr: string | null;
  amountMinor: bigint | null;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED' | 'UNKNOWN';
  rawStatus: string;
  date: Date | null;
  error?: string;
}

const STATUS: Record<string, StatementRow['status']> = {
  success: 'SUCCESS', successful: 'SUCCESS', captured: 'SUCCESS', paid: 'SUCCESS', processed: 'SUCCESS', completed: 'SUCCESS', settled: 'SUCCESS',
  failed: 'FAILED', failure: 'FAILED', declined: 'FAILED', rejected: 'FAILED', expired: 'FAILED',
  pending: 'PENDING', processing: 'PENDING', initiated: 'PENDING',
  reversed: 'REVERSED', returned: 'REVERSED', refunded: 'REVERSED',
};

/**
 * Parse the generic provider statement format (docs/SETTLEMENT.md §5): a header row with at least
 * reference, amount, status, date; optional provider_txn_id, utr, rrn. Amounts are rupee strings.
 */
export function parseStatement(text: string): { rows: StatementRow[]; error?: string } {
  const [header, ...lines] = parseCsv(text);
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  const missing = RECON_CSV_REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) return { rows: [], error: `Missing column(s): ${missing.join(', ')}` };
  const get = (cells: string[], name: string) => {
    const i = cols.indexOf(name);
    const v = i >= 0 ? (cells[i] ?? '').trim() : '';
    return v === '' ? null : v;
  };
  const rows = lines.map((cells, i): StatementRow => {
    const reference = get(cells, 'reference') ?? '';
    const rawStatus = get(cells, 'status') ?? '';
    let amountMinor: bigint | null = null;
    let error: string | undefined;
    try {
      amountMinor = parseMajorToMinor(get(cells, 'amount') ?? '', 'INR');
    } catch {
      error = 'Invalid amount';
    }
    const d = get(cells, 'date');
    const date = d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+05:30` : d) : null;
    return {
      lineNo: i + 2,
      reference,
      providerTxnId: get(cells, 'provider_txn_id'),
      utr: get(cells, 'utr') ?? get(cells, 'rrn'),
      amountMinor,
      status: STATUS[rawStatus.toLowerCase()] ?? 'UNKNOWN',
      rawStatus,
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      error: error ?? (!reference ? 'Missing reference' : undefined),
    };
  });
  return { rows };
}

export type MatchResult = 'MATCHED' | 'AMOUNT_MISMATCH' | 'STATUS_MISMATCH';

/** Compare one provider row with our record. `internalSucceeded` = money moved on our ledger. */
export function compare(row: Pick<StatementRow, 'amountMinor' | 'status'>, internal: { amountMinor: bigint; succeeded: boolean; reversed?: boolean }): MatchResult {
  const extSuccess = row.status === 'SUCCESS' || row.status === 'REVERSED';
  if (row.status === 'REVERSED' && !internal.reversed) return 'STATUS_MISMATCH';
  if (extSuccess !== internal.succeeded && row.status !== 'PENDING') return 'STATUS_MISMATCH';
  if (row.status === 'PENDING' && internal.succeeded) return 'STATUS_MISMATCH';
  if (row.amountMinor !== internal.amountMinor) return 'AMOUNT_MISMATCH';
  return 'MATCHED';
}
