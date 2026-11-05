'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Clock, ExternalLink, Loader2, Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { useBrand } from '@/lib/brand/brand-provider';
import { type AgentBilling, type AgentOrder, type AgentPlan, inr, istDate } from './api';
import { UsageBar } from './bits';
import { AGENT_KEY, BILLING_KEY } from './hooks';
import { Segmented } from './new-transaction';

const PENDING_ORDER = 'pay2all.agent.pending-order';

function readPending(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(PENDING_ORDER);
  } catch {
    return null;
  }
}
function writePending(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(PENDING_ORDER, id);
    else window.sessionStorage.removeItem(PENDING_ORDER);
  } catch {
    /* private mode: polling just won't resume after the redirect */
  }
}

/** Feature lines for a plan card, from the plan's own switches and limits. */
export function planFeatures(p: AgentPlan): { label: string; on: boolean }[] {
  return [
    { label: p.monthly_txn_limit === null ? 'Unlimited entries a month' : `${p.monthly_txn_limit.toLocaleString('en-IN')} entries a month`, on: true },
    { label: `${p.staff_limit} ${p.staff_limit === 1 ? 'login' : 'logins'} (owner included)`, on: true },
    { label: 'Receipts, customers, reports, CSV', on: true },
    { label: 'Free WhatsApp share of receipts', on: true },
    { label: 'Google Drive backup', on: p.drive_backup },
    { label: 'Your logo and footer on receipts', on: p.branded_receipts },
    { label: 'Automatic SMS / WhatsApp receipts', on: p.messaging },
  ];
}

/** /agent/plan: current plan and usage, plan comparison, payment and order history. */
export function AgentPlanPage() {
  const can = useCan();
  const brand = useBrand();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: BILLING_KEY, queryFn: () => api.get<AgentBilling>('/v1/agent/billing') });
  const [period, setPeriod] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [starting, setStarting] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(readPending);
  const [paid, setPaid] = useState<AgentOrder | null>(null);
  const [cancelling, setCancelling] = useState<AgentOrder | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const manage = can('agent.billing.manage');

  // Back from the hosted checkout: check the order until it is paid or closed.
  const pending = useQuery({
    queryKey: [...BILLING_KEY, 'order', pendingId],
    queryFn: () => api.get<AgentOrder>(`/v1/agent/billing/orders/${pendingId}`),
    enabled: Boolean(pendingId),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'PENDING' ? false : 4000),
  });
  useEffect(() => {
    const o = pending.data;
    if (!o || o.status === 'PENDING') return;
    writePending(null);
    if (o.status === 'PAID') {
      toast.success(`Payment received — you're on ${o.plan_name}`);
      void qc.invalidateQueries({ queryKey: AGENT_KEY });
    }
    // Showing the outcome is the point of this effect; it runs once per finished order.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaid(o.status === 'PAID' ? o : null);
    setPendingId(null);
  }, [pending.data, qc]);

  async function checkout(plan: AgentPlan) {
    setStarting(plan.code);
    try {
      const o = await api.post<AgentOrder>('/v1/agent/billing/checkout', { plan_code: plan.code, period });
      if (!o.checkout_url) throw new Error('No payment link');
      writePending(o.id);
      window.location.assign(o.checkout_url);
    } catch (err) {
      toast.error(errorMessage(err));
      setStarting(null);
    }
  }

  async function cancel(o: AgentOrder) {
    setCancelBusy(true);
    try {
      await api.post(`/v1/agent/billing/orders/${o.id}/cancel`);
      if (pendingId === o.id) {
        writePending(null);
        setPendingId(null);
      }
      toast.success('Order cancelled');
      await qc.invalidateQueries({ queryKey: BILLING_KEY });
      setCancelling(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCancelBusy(false);
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const b = q.data;
  return (
    <>
      <PageHeader title="Plan" description="Pick the plan that fits your counter. Your data stays the same on every plan." />
      {!b ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <div className="space-y-6">
          {paid && (
            <Alert className="border-success/40 bg-success-muted">
              <CheckCircle2 className="text-success" />
              <AlertDescription className="text-foreground">
                Payment received — you&apos;re on {paid.plan_name}
                {paid.period_end ? ` until ${istDate(paid.period_end)}` : ''}.
              </AlertDescription>
            </Alert>
          )}
          {pendingId && (
            <Alert>
              <Loader2 className="animate-spin" />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                Checking your payment… This page updates as soon as it is received.
                {pending.data?.checkout_url && (
                  <a href={pending.data.checkout_url} className="text-primary font-medium hover:underline">
                    Open payment page
                  </a>
                )}
              </AlertDescription>
            </Alert>
          )}
          <UsageBar plan={b.current} usage={b.usage} canUpgrade={false} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Plans</h2>
            <div className="w-64">
              <Segmented
                label="Billing period"
                value={period}
                onChange={setPeriod}
                options={[
                  { value: 'MONTHLY', label: 'Monthly' },
                  { value: 'YEARLY', label: 'Yearly' },
                ]}
              />
            </div>
          </div>
          {!b.online_payment_available && manage && (
            <Alert>
              <AlertDescription>
                Online payment for plans is not available yet. Contact support to upgrade
                {brand.support_email ? (
                  <>
                    {' '}
                    at{' '}
                    <a className="text-primary font-medium hover:underline" href={`mailto:${brand.support_email}`}>
                      {brand.support_email}
                    </a>
                  </>
                ) : null}
                {brand.support_phone ? ` or ${brand.support_phone}` : ''}.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            {b.plans.map((p) => {
              const current = p.code === b.current.code;
              const price = period === 'YEARLY' ? p.price_yearly : p.price_monthly;
              const free = p.code === 'FREE';
              return (
                <article key={p.code} className={cn('bg-card flex flex-col rounded-xl border p-5', current && 'border-primary ring-primary ring-1')}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold">{p.name}</h3>
                    {current && <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">Current</span>}
                  </div>
                  {p.description && <p className="text-muted-foreground mt-1 text-sm">{p.description}</p>}
                  <p className="mt-4">
                    <span className="text-3xl font-semibold tabular-nums">{free ? '₹0' : inr(price)}</span>
                    {!free && <span className="text-muted-foreground text-sm"> / {period === 'YEARLY' ? 'year' : 'month'}</span>}
                  </p>
                  <ul className="mt-4 flex-1 space-y-2 text-sm">
                    {planFeatures(p).map((f) => (
                      <li key={f.label} className={cn('flex items-start gap-2', !f.on && 'text-muted-foreground')}>
                        {f.on ? <Check className="text-success mt-0.5 size-4 shrink-0" aria-label="Included" /> : <Minus className="mt-0.5 size-4 shrink-0" aria-label="Not included" />}
                        {f.label}
                      </li>
                    ))}
                  </ul>
                  {!free && manage && (
                    <Button
                      className="mt-5 h-11"
                      variant={current ? 'outline' : 'default'}
                      disabled={!b.online_payment_available || Boolean(starting) || Number(price) < 1}
                      onClick={() => void checkout(p)}
                    >
                      {starting === p.code && <Loader2 className="animate-spin" />}
                      {current ? `Renew ${period === 'YEARLY' ? 'for a year' : 'for a month'}` : `Upgrade to ${p.name}`}
                    </Button>
                  )}
                  {current && b.current.expires_at && <p className="text-muted-foreground mt-2 text-center text-xs">Active until {istDate(b.current.expires_at)}. Renewing adds to it.</p>}
                </article>
              );
            })}
          </div>
          {!manage && <p className="text-muted-foreground text-sm">Only the shop owner can change the plan.</p>}

          {b.orders.length > 0 && (
            <section className="bg-card overflow-hidden rounded-xl border">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">Orders</h2>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Valid till</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {b.orders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="whitespace-nowrap">{istDate(o.created_at)}</TableCell>
                        <TableCell>
                          {o.plan_name} · {o.granted ? 'granted' : o.period === 'YEARLY' ? 'yearly' : 'monthly'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.granted ? '—' : inr(o.amount)}</TableCell>
                        <TableCell>
                          <StatusBadge status={o.status} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{o.period_end ? istDate(o.period_end) : '—'}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {o.status === 'PENDING' && (
                            <span className="inline-flex gap-1">
                              {o.checkout_url && (
                                <Button variant="ghost" size="sm" asChild>
                                  <a
                                    href={o.checkout_url}
                                    onClick={() => {
                                      writePending(o.id);
                                    }}
                                  >
                                    <ExternalLink /> Pay
                                  </a>
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  writePending(o.id);
                                  setPendingId(o.id);
                                }}
                              >
                                <Clock /> Check
                              </Button>
                              {manage && (
                                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setCancelling(o)}>
                                  Cancel
                                </Button>
                              )}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this order?"
        description="Its payment link stops working. If you have already paid, wait a minute and press Check instead."
        confirmLabel="Cancel order"
        destructive
        pending={cancelBusy}
        onConfirm={() => cancelling && void cancel(cancelling)}
      />
    </>
  );
}
