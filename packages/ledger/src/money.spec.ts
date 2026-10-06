import { describe, expect, it } from 'vitest';
import { divRound, formatMinor, minorToMajorString, MoneyError, parseMajorToMinor } from './money';

describe('parseMajorToMinor', () => {
  it('parses exactly without floating point', () => {
    expect(parseMajorToMinor('1000')).toBe(100000n);
    expect(parseMajorToMinor('1000.5')).toBe(100050n);
    expect(parseMajorToMinor('0.01')).toBe(1n);
    expect(parseMajorToMinor('0.10')).toBe(10n);
    // 0.1 + 0.2 style traps are impossible: digits are handled as strings.
    expect(parseMajorToMinor('999999999999999.99')).toBe(99999999999999999n);
  });

  it('rejects ambiguous or malformed input instead of rounding', () => {
    for (const bad of ['1.234', '-1', '1e5', '1,000', ' 10', '', '.5', '10.', 'NaN']) {
      expect(() => parseMajorToMinor(bad), bad).toThrow(MoneyError);
    }
  });

  it('rejects unsupported currencies', () => {
    expect(() => parseMajorToMinor('1', 'USD')).toThrow(/Unsupported currency/);
  });
});

describe('formatting', () => {
  it('round-trips and groups Indian style', () => {
    expect(minorToMajorString(100050n)).toBe('1000.50');
    expect(minorToMajorString(-5n)).toBe('-0.05');
    expect(formatMinor(1234567890n)).toBe('₹1,23,45,678.90');
  });
});

describe('divRound', () => {
  it('rounds half up by default', () => {
    expect(divRound(15n, 10n)).toBe(2n);
    expect(divRound(14n, 10n)).toBe(1n);
    expect(divRound(14n, 10n, 'UP')).toBe(2n);
    expect(divRound(19n, 10n, 'DOWN')).toBe(1n);
  });
});

describe('fee and tax math', () => {
  it('reproduces the LEDGER.md worked example exactly', async () => {
    const { parseRateMicros, percentOf, taxOn } = await import('./money.js');
    // ₹1,000.00 at 0.18 % with GST 18 % → fee 180 paise, GST 32.4 → 32 paise, net 99788.
    const fee = percentOf(100000n, parseRateMicros('0.18'));
    const gst = taxOn(fee, parseRateMicros('18'));
    expect(fee).toBe(180n);
    expect(gst).toBe(32n);
    expect(100000n - fee - gst).toBe(99788n);
    // Payout example: ₹5 fee + 18 % GST = 90 paise.
    expect(taxOn(500n, parseRateMicros('18'))).toBe(90n);
  });

  it('rounds half up once per component and clamps', async () => {
    const { clamp, parseRateMicros, percentOf } = await import('./money.js');
    expect(percentOf(250n, parseRateMicros('1'))).toBe(3n); // 2.5 → 3
    expect(percentOf(249n, parseRateMicros('1'))).toBe(2n); // 2.49 → 2
    expect(clamp(5n, 10n, 100n)).toBe(10n);
    expect(clamp(500n, 10n, 100n)).toBe(100n);
    expect(() => parseRateMicros('101')).toThrow();
    expect(() => parseRateMicros('0.1234567')).toThrow();
  });
});
