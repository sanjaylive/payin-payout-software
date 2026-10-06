import { cn } from '@pay2all/ui/lib/utils';

/** Pay2All wordmark — original mark: two interlocking arrows (collect + pay out). */
export function Brand({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M9 13h11l-3.5-3.5M23 19H12l3.5 3.5" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={cn('text-[15px]', inverted ? 'text-white' : 'text-foreground')}>
        Pay2All <span className={inverted ? 'text-sidebar-muted font-medium' : 'text-muted-foreground font-medium'}>Payments</span>
      </span>
    </span>
  );
}
