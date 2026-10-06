/**
 * Money helpers — the only sanctioned way to convert between human amounts and stored minor units.
 * Amounts are integers in the currency's smallest unit (paise for INR) held in `bigint`.
 * No floating point anywhere (docs/LEDGER.md §2).
 */

export interface CurrencyInfo {
  code: string;
  exponent: number;
  symbol: string;
}

/** Supported currencies. INR only for now; adding one is a config change, not a code change. */
export const CURRENCIES: Record<string, CurrencyInfo> = {
  INR: { code: 'INR', exponent: 2, symbol: '₹' },
};

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function currencyInfo(code: string): CurrencyInfo {
  const info = CURRENCIES[code];
  if (!info) throw new MoneyError(`Unsupported currency: ${code}`);
  return info;
}

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/** Upper bound for any single amount: ₹1,00,00,00,000 crore-scale guard well inside BIGINT. */
export const MAX_MINOR = 10n ** 17n;

/**
 * Parse a decimal string in major units ("1000", "1000.5", "1000.50") into minor units.
 * Rejects more fractional digits than the currency allows (no silent rounding), signs,
 * exponents, separators and whitespace.
 */
export function parseMajorToMinor(input: string, currency = 'INR'): bigint {
  const { exponent } = currencyInfo(currency);
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(input);
  if (!match) throw new MoneyError('Amount must be a positive decimal number like 1000.00');
  const [, whole, fraction = ''] = match;
  if (fraction.length > exponent) throw new MoneyError(`Amount allows at most ${exponent} decimal places`);
  const minor = BigInt(whole!) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > MAX_MINOR) throw new MoneyError('Amount is too large');
  return minor;
}

/** Minor units → canonical decimal string in major units ("1000.50"). */
export function minorToMajorString(minor: bigint, currency = 'INR'): string {
  const { exponent } = currencyInfo(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const factor = 10n ** BigInt(exponent);
  const whole = (abs / factor).toString();
  const frac = (abs % factor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}${exponent ? `.${frac}` : ''}`;
}

/** Human display with Indian digit grouping: ₹1,00,000.00 */
export function formatMinor(minor: bigint, currency = 'INR'): string {
  const { exponent, symbol } = currencyInfo(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const factor = 10n ** BigInt(exponent);
  const grouped = new Intl.NumberFormat('en-IN').format(abs / factor);
  const frac = (abs % factor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${symbol}${grouped}${exponent ? `.${frac}` : ''}`;
}

export type RoundingMode = 'HALF_UP' | 'DOWN' | 'UP';

/**
 * Integer division with explicit rounding (non-negative operands). Used by fee math:
 * fee = amount × rate, where rate is a scaled integer.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode = 'HALF_UP'): bigint {
  if (denominator <= 0n || numerator < 0n) throw new MoneyError('divRound expects non-negative numerator and positive denominator');
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n) return q;
  switch (mode) {
    case 'DOWN':
      return q;
    case 'UP':
      return q + 1n;
    case 'HALF_UP':
      return r * 2n >= denominator ? q + 1n : q;
  }
}

/** Serialize for JSON APIs: minor units as a decimal string (bigint is not JSON-safe). */
export const minorToJson = (minor: bigint | null | undefined): string | null =>
  minor === null || minor === undefined ? null : minor.toString();
