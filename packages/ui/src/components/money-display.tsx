import { formatMinor } from '../lib/money';
import { cn } from '../lib/utils';

export interface MoneyDisplayProps {
  /** Integer minor units (paise) as string or bigint. */
  amountMinor: string | bigint;
  currency?: string;
  className?: string;
  /** Colour positive/negative values (ledger views). */
  signed?: boolean;
}

export function MoneyDisplay({ amountMinor, currency = 'INR', className, signed }: MoneyDisplayProps) {
  const value = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  return (
    <span
      className={cn(
        'tabular font-medium whitespace-nowrap',
        signed && value < 0n && 'text-destructive',
        signed && value > 0n && 'text-success',
        className,
      )}
    >
      {formatMinor(value, currency)}
    </span>
  );
}
