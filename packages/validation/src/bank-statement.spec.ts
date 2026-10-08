import { describe, expect, it } from 'vitest';
import { parseBankStatement, parseStatementAmount, parseStatementDate, referenceCandidates, StatementFormatError } from './bank-statement';

describe('bank statement parsing', () => {
  it('finds the header below summary rows (HDFC-style), keeps credits only, reads UTRs from narration', () => {
    const csv = [
      'Account Number,50100123457890',
      'Statement From,01/10/2026,To,08/10/2026',
      '',
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '05/10/26,UPI-SHARMA ELEC-sharma@okhdfc-HDFC0001234-427812345678-Top up,0000427812345678,05/10/26,,"25,000.00","1,25,000.00"',
      '06/10/26,NEFT CR-ICIC0000001-KIRANA FRESH-N279260012345678,N279260012345678,06/10/26,,1000.5,126000.50',
      '06/10/26,ATM WDL,,06/10/26,500.00,,125500.50',
      '07/10/26,Opening adjustment,,07/10/26,,,125500.50',
    ].join('\n');
    const s = parseBankStatement(csv);
    expect(s.columns).toEqual({ date: 'Date', description: 'Narration', reference: 'Chq./Ref.No.', credit: 'Deposit Amt.' });
    expect(s.debits).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.credits).toHaveLength(2);
    expect(s.credits[0]).toMatchObject({ lineNo: 4, amountMinor: 2_500_000n, valueDate: new Date('2026-10-04T18:30:00.000Z') });
    expect(s.credits[0]!.references).toEqual(['0000427812345678', '427812345678']);
    expect(s.credits[1]).toMatchObject({ amountMinor: 100_050n, references: ['N279260012345678'] });
  });

  it('handles a single amount column with a CR/DR indicator (SBI-style) and month names', () => {
    const csv = ['Txn Date,Description,Ref No,Amount,Type', '05 Oct 2026,BY TRANSFER-IMPS/P2A/627812345678/X,627812345678,"5,000",CR', '05 Oct 2026,TO TRANSFER,,200,DR'].join('\n');
    const s = parseBankStatement(csv);
    expect(s.credits).toEqual([{ lineNo: 2, valueDate: new Date('2026-10-04T18:30:00.000Z'), description: 'BY TRANSFER-IMPS/P2A/627812345678/X', amountMinor: 500_000n, references: ['627812345678'] }]);
    expect(s.debits).toBe(1);
  });

  it('rejects files without recognisable columns', () => {
    expect(() => parseBankStatement('a,b\n1,2')).toThrow(StatementFormatError);
  });

  it('parses amounts exactly and refuses anything else', () => {
    expect(parseStatementAmount('1,23,456.7')).toBe(12_345_670n);
    expect(parseStatementAmount('₹ 99')).toBe(9_900n);
    expect(parseStatementAmount('0.00')).toBeNull();
    expect(parseStatementAmount('-5')).toBeNull();
    expect(parseStatementAmount('1.234')).toBeNull();
    expect(parseStatementAmount('')).toBeNull();
  });

  it('parses common date formats as IST calendar dates', () => {
    for (const v of ['2026-10-05', '05/10/2026', '5-10-26', '05-Oct-2026', '05 October 2026']) expect(parseStatementDate(v)?.toISOString(), v).toBe('2026-10-04T18:30:00.000Z');
    expect(parseStatementDate('31/13/2026')).toBeNull();
  });

  it('only treats long, digit-heavy tokens as references', () => {
    expect(referenceCandidates('UPI/RAMESH/9876/ok', 'NEFT HDFCN52026100812345678 SALARY')).toEqual(['HDFCN52026100812345678']);
  });
});
