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
