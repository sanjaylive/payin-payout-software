import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  timestamp: string | Date;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

const DOT: Record<NonNullable<TimelineItem['tone']>, string> = {
  default: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

/** Vertical event timeline — used for transaction activity and audit trails. */
export function ActivityTimeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn('relative space-y-5 border-l pl-5', className)}>
      {items.map((item) => (
        <li key={item.id} className="relative">
          <span className={cn('ring-background absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4', DOT[item.tone ?? 'default'])} aria-hidden />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="text-sm font-medium">{item.title}</p>
            <time className="text-muted-foreground text-xs" dateTime={new Date(item.timestamp).toISOString()}>
              {formatDateTime(item.timestamp)}
            </time>
          </div>
          {item.description && <div className="text-muted-foreground mt-0.5 text-sm">{item.description}</div>}
        </li>
      ))}
    </ol>
  );
}

export interface AuditTimelineEntry {
  id: string;
  action: string;
  actor_id: string | null;
  actor_type: string;
  created_at: string;
  ip_address: string | null;
  request_id: string | null;
}

/** Audit-specific timeline: action, actor and correlation id for each immutable entry. */
export function AuditTimeline({ entries, className }: { entries: AuditTimelineEntry[]; className?: string }) {
  return (
    <ActivityTimeline
      className={className}
      items={entries.map((e) => ({
        id: e.id,
        title: <span className="font-mono text-xs">{e.action}</span>,
        timestamp: e.created_at,
        tone: e.action.includes('failed') || e.action.includes('reuse') || e.action.includes('locked') ? 'danger' : 'default',
        description: (
          <span className="font-mono text-xs">
            {e.actor_type} {e.actor_id ?? '—'} · {e.ip_address ?? 'no ip'} · {e.request_id ?? 'no request id'}
          </span>
        ),
      }))}
    />
  );
}
