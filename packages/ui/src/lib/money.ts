/**
 * Display-only money formatting. Amounts arrive from the API as integer minor units (paise) encoded
 * as strings, and are formatted with BigInt arithmetic — never via JavaScript floating point.
 */
const CURRENCY_EXPONENT: Record<string, number> = { INR: 2 };
const CURRENCY_SYMBOL: Record<string, string> = { INR: '₹' };

export function formatMinor(minor: string | bigint, currency = 'INR', opts: { showSymbol?: boolean } = {}): string {
  const exponent = CURRENCY_EXPONENT[currency] ?? 2;
  let value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  if (negative) value = -value;
  const factor = 10n ** BigInt(exponent);
  const major = value / factor;
  const fraction = (value % factor).toString().padStart(exponent, '0');
  // en-IN grouping (1,00,00,000) via Intl on BigInt — exact for any size.
  const grouped = new Intl.NumberFormat('en-IN').format(major);
  const symbol = opts.showSymbol === false ? '' : (CURRENCY_SYMBOL[currency] ?? `${currency} `);
  return `${negative ? '-' : ''}${symbol}${grouped}${exponent > 0 ? `.${fraction}` : ''}`;
}
