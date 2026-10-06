import { Landmark } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Shows bank details using the server-provided masked account number only. The full number is never
 * sent to the browser for display (docs/SECURITY.md §4).
 */
export function BankAccountDisplay({
  holderName,
  accountNumberMasked,
  ifsc,
  bankName,
  className,
}: {
  holderName: string;
  accountNumberMasked: string;
  ifsc: string;
  bankName?: string | null;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3 rounded-lg border p-3', className)}>
      <span className="bg-accent text-accent-foreground grid size-9 place-items-center rounded-md">
        <Landmark className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">{holderName}</p>
        <p className="text-muted-foreground font-mono text-xs">
          {accountNumberMasked} · {ifsc}
          {bankName ? ` · ${bankName}` : ''}
        </p>
      </div>
    </div>
  );
}
