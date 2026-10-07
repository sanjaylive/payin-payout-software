import { PassThrough, type Readable } from 'node:stream';

/**
 * Output format abstraction (docs/REPORTS.md §3). The generator only ever talks to this interface,
 * so an XLSX writer (streaming workbook) can be added without touching queries or the job loop.
 */
export interface ReportWriter {
  readonly contentType: string;
  readonly extension: string;
  /** The byte stream being produced (piped to object storage). */
  readonly stream: Readable;
  writeHeader(columns: readonly string[]): Promise<void>;
  writeRow(values: readonly CellValue[]): Promise<void>;
  end(): Promise<void>;
}

export type CellValue = string | number | bigint | boolean | Date | null | undefined;

/**
 * Spreadsheet formula injection (CWE-1236): a cell starting with = + - @ (or tab / CR) is executed
 * by Excel/Sheets. Prefix such text with an apostrophe. Our own numeric amounts are formatted
 * strings like "-12.00" only in theory (amounts are never negative here), but merchant-supplied
 * text (order ids, narrations, names) is untrusted.
 */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return '';
  const text = v instanceof Date ? v.toISOString() : typeof v === 'string' ? neutraliseFormula(v) : String(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV, UTF-8 with BOM (so Excel opens rupee symbols and names correctly), CRLF rows. */
export class CsvWriter implements ReportWriter {
  readonly contentType = 'text/csv; charset=utf-8';
  readonly extension = 'csv';
  private readonly out = new PassThrough();
  readonly stream: Readable = this.out;

  private write(line: string): Promise<void> {
    if (this.out.destroyed) return Promise.reject(new Error('Report stream closed'));
    // Respect back-pressure so a slow upload never buffers the whole report in memory. If the
    // consumer dies (upload failed), reject instead of waiting for a drain that never comes.
    if (this.out.write(line)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        this.out.off('close', onClose);
        resolve();
      };
      const onClose = () => {
        this.out.off('drain', onDrain);
        reject(new Error('Report stream closed'));
      };
      this.out.once('drain', onDrain);
      this.out.once('close', onClose);
    });
  }

  async writeHeader(columns: readonly string[]): Promise<void> {
    await this.write(`\uFEFF${columns.map(csvCell).join(',')}\r\n`);
  }

  async writeRow(values: readonly CellValue[]): Promise<void> {
    await this.write(`${values.map(csvCell).join(',')}\r\n`);
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve) => this.out.end(() => resolve()));
  }
}

export function writerFor(format: 'CSV' | 'XLSX'): ReportWriter {
  if (format === 'CSV') return new CsvWriter();
  throw new Error('XLSX export is not implemented yet');
}
