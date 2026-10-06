import { cn } from '../lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

/** Default tone per status across payin, payout, settlement, KYC, users, orgs. */
const STATUS_TONES: Record<string, StatusTone> = {
  SUCCESS: 'success', ACTIVE: 'success', APPROVED: 'success', VERIFIED: 'success', SETTLED: 'success', PROCESSED: 'success', MATCHED: 'success', REFUNDED: 'neutral',
  PENDING: 'warning', PROCESSING: 'warning', QUEUED: 'info', CREATED: 'neutral', SUBMITTED: 'info', UNDER_REVIEW: 'info', APPROVAL_PENDING: 'warning', MANUAL_REVIEW: 'warning', MORE_INFORMATION_REQUIRED: 'warning', INVITED: 'info', SETTLEMENT_PENDING: 'info', REFUND_PENDING: 'warning', PARTIALLY_REFUNDED: 'info', ON_HOLD: 'warning', DEGRADED: 'warning', MAINTENANCE: 'info', DRAFT: 'neutral',
  FAILED: 'danger', REJECTED: 'danger', SUSPENDED: 'danger', DISABLED: 'danger', BLOCKED: 'danger', REVOKED: 'danger', REVERSED: 'danger', EXPIRED: 'neutral', CANCELLED: 'neutral', DOWN: 'danger', DISPUTED: 'danger', CHARGEBACK: 'danger', CLOSED: 'neutral', LOCKED: 'danger',
};

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-success-muted text-success ring-success/25',
  warning: 'bg-warning-muted text-warning-foreground ring-warning/30 dark:text-warning',
  danger: 'bg-danger-muted text-destructive ring-destructive/25',
  info: 'bg-info-muted text-info ring-info/25',
  primary: 'bg-accent text-accent-foreground ring-primary/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

export function StatusBadge({ status, tone, className }: { status: string; tone?: StatusTone; className?: string }) {
  const resolved = tone ?? STATUS_TONES[status] ?? 'neutral';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONE_CLASSES[resolved],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status.replaceAll('_', ' ')}
    </span>
  );
}
