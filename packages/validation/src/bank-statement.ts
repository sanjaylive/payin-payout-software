import { parseCsv } from './payouts';

/**
 * Bank statement CSV parsing for automatic fund-request matching (docs/FUND_REQUESTS.md §6).
 * Indian bank exports differ in column names and often start with account-summary rows, so the
 * header row is found by its columns. Only credits are returned; every amount is exact paise.
 */

export interface StatementCredit {
  /** 1-based row number in the file, blank lines not counted (for the review screen). */
  lineNo: number;
  valueDate: Date | null;
  description: string;
  amountMinor: bigint;
  /** Possible UTR / RRN references, upper-cased: the reference column, then tokens from the narration. */
  references: string[];
}

export interface ParsedStatement {
  credits: StatementCredit[];
  debits: number;
  skipped: number;
  columns: { date: string; description: string | null; reference: string | null; credit: string };
}

export class StatementFormatError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();

function pick(headers: string[], ...patterns: RegExp[]): number {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/** "1,23,456.70", "₹ 500", "500.5 Cr" → paise; null when not a positive money value. */
export function parseStatementAmount(raw: string | undefined): bigint | null {
  const v = (raw ?? '').replace(/[₹,\s]|INR|Rs\.?|Cr\.?$/gi, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n ? minor : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** dd/mm/yyyy, dd-mm-yy, dd-MMM-yyyy, dd MMM yyyy, yyyy-mm-dd (time ignored). IST calendar date. */
export function parseStatementDate(raw: string | undefined): Date | null {
  const s = (raw ?? '').trim();
  let d: number | undefined;
  let m: number | undefined;
  let y: number | undefined;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[\s\-/]([A-Za-z]{3})[A-Za-z]*[\s\-/,]+(\d{2,4})/.exec(s))) [d, m, y] = [Number(r[1]), MONTHS[r[2]!.toLowerCase()], Number(r[3])];
  if (!d || !m || !y) return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d) - 19_800_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Reference-looking tokens: 10–22 letters/digits with at least 6 digits (UPI RRN, IMPS, NEFT/RTGS UTR), not IFSC codes. */
export function referenceCandidates(...texts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const token of (t ?? '').toUpperCase().split(/[^A-Z0-9]+/)) {
      // IFSC codes (HDFC0001234) look like references; they never are.
      if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(token)) continue;
      if (token.length >= 10 && token.length <= 22 && (token.match(/\d/g) ?? []).length >= 6 && !out.includes(token)) out.push(token);
    }
  }
  return out;
}

export function parseBankStatement(text: string, maxRows = 20_000): ParsedStatement {
  const rows = parseCsv(text);
  const headerAt = rows.slice(0, 40).findIndex((r) => {
    const h = r.map(norm);
    return h.some((c) => /date/.test(c)) && h.some((c) => /^(credit|deposit|cr)\b|credit amount|deposit amount|^amount/.test(c));
  });
  if (headerAt < 0) throw new StatementFormatError('Could not find the header row: the file needs a date column and a credit (deposit) column');
  const headers = rows[headerAt]!.map(norm);
  const date = pick(headers, /^value date/, /^(txn|tran|transaction) date/, /date/);
  const description = pick(headers, /narration/, /description/, /particulars/, /remarks/, /details/);
  const reference = pick(headers, /utr/, /^(ref|reference)/, /ref no/, /chq|cheque/);
  let credit = pick(headers, /^(credit|deposit)( amount)?$/, /^cr( amount)?$/, /credit/, /deposit/);
  const debit = pick(headers, /^(debit|withdrawal)( amount)?$/, /^dr( amount)?$/, /debit/, /withdrawal/);
  // Single amount column with a CR/DR indicator.
  const indicator = credit < 0 ? pick(headers, /^(cr dr|dr cr|type|txn type|transaction type)$/) : -1;
  if (credit < 0) credit = pick(headers, /^amount/);
  if (date < 0 || credit < 0) throw new StatementFormatError('Could not find the date and credit columns');

  const body = rows.slice(headerAt + 1);
  if (body.length > maxRows) throw new StatementFormatError(`At most ${maxRows.toLocaleString('en-IN')} rows per file`);
  const credits: StatementCredit[] = [];
  let debits = 0;
  let skipped = 0;
  body.forEach((r, i) => {
    const lineNo = headerAt + i + 2;
    if (indicator >= 0 && !/^c/i.test((r[indicator] ?? '').trim())) {
      if (/^d/i.test((r[indicator] ?? '').trim())) debits++;
      else skipped++;
      return;
    }
    const amount = parseStatementAmount(r[credit]);
    if (amount === null) {
      if (debit >= 0 && parseStatementAmount(r[debit]) !== null) debits++;
      else skipped++;
      return;
    }
    const desc = description >= 0 ? (r[description] ?? '').trim() : '';
    credits.push({
      lineNo,
      valueDate: parseStatementDate(r[date]),
      description: desc.slice(0, 300),
      amountMinor: amount,
      references: referenceCandidates(reference >= 0 ? r[reference] : undefined, desc),
    });
  });
  return { credits, debits, skipped, columns: { date: rows[headerAt]![date]!, description: description >= 0 ? rows[headerAt]![description]! : null, reference: reference >= 0 ? rows[headerAt]![reference]! : null, credit: rows[headerAt]![credit]! } };
}
