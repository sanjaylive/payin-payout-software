import { describe, expect, it } from 'vitest';
import { CsvWriter, csvCell } from './report-writer';

describe('csv writer', () => {
  it('quotes, escapes and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+91 98765')).toBe("'+91 98765");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12n)).toBe('12');
    expect(csvCell(new Date('2026-10-07T00:00:00.000Z'))).toBe('2026-10-07T00:00:00.000Z');
  });

  it('streams a BOM, header and CRLF rows', async () => {
    const w = new CsvWriter();
    const chunks: Buffer[] = [];
    w.stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    await w.writeHeader(['id', 'amount']);
    await w.writeRow(['pay_1', '100.00']);
    await w.end();
    expect(Buffer.concat(chunks).toString('utf8')).toBe('﻿id,amount\r\npay_1,100.00\r\n');
  });
});
