'use client';

import { StatusBadge, type StatusTone } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { cn } from '@pay2all/ui/lib/utils';
import { ArrowDownLeft, ArrowUpRight, Crown } from 'lucide-react';
import Link from 'next/link';
import { type AgentCurrentPlan, type AgentTxn, type AgentTxnStatus, type AgentUsage, inr, istDate, istDateTime, STATUS_LABEL, TYPE_LABEL } from './api';

export const statusTone = (s: AgentTxnStatus): StatusTone => (s === 'SUCCESS' ? 'success' : s === 'PENDING' ? 'warning' : s === 'FAILED' ? 'danger' : 'neutral');

export function TxnStatus({ status, className }: { status: AgentTxnStatus; className?: string }) {
  return <StatusBadge status={STATUS_LABEL[status]} tone={statusTone(status)} className={className} />;
}

/** A transaction as one tappable row: type, who, when, amount with direction. */
export function TxnRow({ t, onClick, href }: { t: AgentTxn; onClick?: () => void; href?: string }) {
  const In = t.direction === 'IN';
  const body = (
    <>
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-full', In ? 'bg-success-muted text-success' : 'bg-warning-muted text-warning-foreground dark:text-warning')}>
        {In ? <ArrowDownLeft className="size-5" aria-hidden /> : <ArrowUpRight className="size-5" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {TYPE_LABEL[t.type]}
          {t.customer?.name ? <span className="text-muted-foreground font-normal"> · {t.customer.name}</span> : null}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {t.receipt_no} · {istDateTime(t.occurred_at)}
          {t.beneficiary ? ` · to ${t.beneficiary.name}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className={cn('block text-sm font-semibold tabular-nums', (t.status === 'FAILED' || t.status === 'REFUNDED') && 'text-muted-foreground line-through')}>
          {In ? '+' : '−'}
          {inr(t.amount)}
        </span>
        <TxnStatus status={t.status} className="mt-0.5" />
      </span>
    </>
  );
  const cls = 'hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors';
  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

/** This month's transactions against the plan's allowance; nudges an upgrade from 80%. */
export function UsageBar({ plan, usage, canUpgrade, className }: { plan: AgentCurrentPlan; usage: AgentUsage; canUpgrade: boolean; className?: string }) {
  const limit = plan.monthly_txn_limit;
  const used = usage.transactions_this_month;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const near = limit !== null && pct >= 80;
  return (
    <div className={cn('bg-card rounded-xl border p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Crown className="text-primary size-4" aria-hidden />
          <span className="text-sm font-semibold">{plan.name} plan</span>
          {plan.expires_at && <span className="text-muted-foreground text-xs">till {istDate(plan.expires_at)}</span>}
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {limit === null ? `${used.toLocaleString('en-IN')} this month · unlimited` : `${used.toLocaleString('en-IN')} / ${limit.toLocaleString('en-IN')} this month`}
        </span>
      </div>
      {limit !== null && (
        <div
          className="bg-muted mt-3 h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Transactions used this month"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
        >
          <div className={cn('h-full rounded-full transition-all', pct >= 100 ? 'bg-destructive' : near ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
      )}
      {plan.lapsed_from && <p className="text-warning-foreground dark:text-warning mt-2 text-xs">Your paid plan has ended. You are on Free until you renew.</p>}
      {(near || plan.lapsed_from) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">{pct >= 100 ? 'You have used this month’s entries.' : near ? `You have used ${pct}% of this month’s entries.` : ''}</p>
          {canUpgrade && (
            <Button size="sm" asChild>
              <Link href="/agent/plan">{plan.lapsed_from ? 'Renew' : 'Upgrade'}</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Small "Starter / Business only" marker for features a plan lacks. */
export function PlanTag({ children }: { children: string }) {
  return <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">{children}</span>;
}
