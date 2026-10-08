'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock3, ExternalLink, Globe, Info, Link2, Loader2, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { api, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { CheckoutSessionRow, MerchantWebsite } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const WEBSITES_KEY = ['checkout-websites'];
const SESSIONS_KEY = ['checkout-sessions'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newKey = () => `k_${crypto.randomUUID().replace(/-/g, '')}`;

export function WebsiteStatus({ status }: { status: MerchantWebsite['status'] }) {
  const m = {
    PENDING: { label: 'In review', cls: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300', icon: Clock3 },
    APPROVED: { label: 'Approved', cls: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300', icon: CheckCircle2 },
    REJECTED: { label: 'Rejected', cls: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300', icon: XCircle },
  }[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', m.cls)}>
      <m.icon className="size-3" /> {m.label}
    </span>
  );
}

const useWebsites = () => useQuery({ queryKey: WEBSITES_KEY, queryFn: () => api.get<MerchantWebsite[]>('/v1/checkout/websites') });

/** Developers → Websites: where checkout may send customers back to. */
export function Websites() {
  const q = useWebsites();
  const qc = useQueryClient();
  const can = useCan();
  const canEdit = can('api_key.manage');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      await api.post('/v1/checkout/websites', { url: url.trim(), label: label.trim() || undefined });
      toast.success('Website added — Pay2All will review it shortly');
      setUrl('');
      setLabel('');
      await qc.invalidateQueries({ queryKey: WEBSITES_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(w: MerchantWebsite) {
    try {
      await api.post(`/v1/checkout/websites/${w.id}/remove`);
      toast.success(`${w.url} removed`);
      await qc.invalidateQueries({ queryKey: WEBSITES_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-5 [.border-b]:pb-4">
          <CardTitle className="text-base">Your websites</CardTitle>
          <CardDescription>Checkout returns customers only to approved websites. Each new website is reviewed by Pay2All.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
              <Globe className="size-7" /> No websites yet. Add the site your customers pay from.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                    <Globe className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <a href={w.url} target="_blank" rel="noopener noreferrer" className="block truncate font-medium hover:underline">
                      {w.url}
                    </a>
                    <p className="text-muted-foreground truncate text-xs">
                      {w.label ? `${w.label} · ` : ''}added {formatRelative(w.created_at)}
                      {w.status === 'REJECTED' && w.review_note ? ` · “${w.review_note}”` : ''}
                    </p>
                  </div>
                  <WebsiteStatus status={w.status} />
                  {canEdit && (
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-8" aria-label={`Remove ${w.url}`} onClick={() => void remove(w)}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {canEdit && (
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="size-4" /> Add a website
            </CardTitle>
            <CardDescription>Only the address is stored, e.g. https://shop.example.com — any page on it can be a return URL.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="web-url">Website address</Label>
              <Input id="web-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-label">
                Label <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input id="web-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main store" maxLength={80} />
            </div>
            <Button className="w-full" disabled={busy || url.trim().length < 4} onClick={() => void add()}>
              {busy && <Loader2 className="size-4 animate-spin" />} Add website
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const SESSION_STATUS: Record<CheckoutSessionRow['status'], string> = {
  OPEN: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300',
  PAID: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
  EXPIRED: 'bg-muted text-muted-foreground ring-border',
  CANCELLED: 'bg-muted text-muted-foreground ring-border',
};

/** Payin → Checkout: create hosted checkout links and follow them. */
export function CheckoutSessions() {
  const websites = useWebsites();
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'ALL' | CheckoutSessionRow['status']>('ALL');
  const approved = (websites.data ?? []).filter((w) => w.status === 'APPROVED');
  const [form, setForm] = useState({ amount: '', order: '', description: '', site: '', path: '/', name: '', email: '', mobile: '' });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CheckoutSessionRow | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const site = form.site || approved[0]?.url || '';

  const list = useInfiniteQuery({
    queryKey: [...SESSIONS_KEY, tab],
    queryFn: ({ pageParam }) => apiRequest<CheckoutSessionRow[]>('/v1/checkout/sessions', { query: { status: tab === 'ALL' ? undefined : tab, limit: 20, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  async function create() {
    setBusy(true);
    try {
      const customer = { ...(form.name.trim() ? { name: form.name.trim() } : {}), ...(form.email.trim() ? { email: form.email.trim() } : {}), ...(form.mobile.trim() ? { mobile: form.mobile.trim() } : {}) };
      const res = await apiRequest<CheckoutSessionRow>('/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'Idempotency-Key': newKey() },
        body: { merchant_order_id: form.order.trim(), amount: Number(form.amount).toFixed(2), description: form.description.trim() || undefined, return_url: `${site}${form.path.startsWith('/') ? form.path : `/${form.path}`}`, ...(Object.keys(customer).length ? { customer } : {}) },
      });
      setCreated(res.data);
      toast.success('Checkout link created');
      setForm((f) => ({ ...f, amount: '', order: '', description: '', name: '', email: '', mobile: '' }));
      await qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const valid = /^\d{1,9}(\.\d{1,2})?$/.test(form.amount) && Number(form.amount) >= 1 && /^[A-Za-z0-9_\-/.:]{1,60}$/.test(form.order.trim()) && !!site;
  return (
    <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card className="h-fit shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" /> New checkout link
          </CardTitle>
          <CardDescription>Share it with a customer, or create links from your server with the API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!websites.isLoading && approved.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm">
              <p className="font-medium">Add your website first</p>
              <p className="text-muted-foreground mt-1 text-xs">Customers return to your website after paying, so it needs to be added and approved.</p>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link href="/developers/websites">Go to Websites</Link>
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cs-amount">Amount (₹)</Label>
                  <Input id="cs-amount" value={form.amount} onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="999.00" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cs-order">Order ID</Label>
                  <Input id="cs-order" value={form.order} onChange={(e) => set('order', e.target.value)} placeholder="ORD-1042" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cs-desc">
                  Description <span className="text-muted-foreground font-normal">(shown to the customer)</span>
                </Label>
                <Input id="cs-desc" value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={200} placeholder="2 × Blue kurta" />
              </div>
              <div className="space-y-1.5">
                <Label>Return customers to</Label>
                <div className="flex gap-2">
                  <Select value={site} onValueChange={(v) => set('site', v)}>
                    <SelectTrigger className="min-w-0 flex-1" aria-label="Website">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {approved.map((w) => (
                        <SelectItem key={w.id} value={w.url}>
                          {w.url.replace(/^https?:\/\//, '')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input aria-label="Return path" value={form.path} onChange={(e) => set('path', e.target.value)} className="w-28 font-mono text-xs" />
                </div>
              </div>
              <details className="group rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Prefill customer details (optional)</summary>
                <div className="mt-3 space-y-2">
                  <Input aria-label="Customer name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Name" />
                  <Input aria-label="Customer email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="Email" />
                  <Input aria-label="Customer mobile" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="Mobile" />
                </div>
              </details>
              <Button className="w-full" disabled={!valid || busy || !can('payin.create')} onClick={() => void create()}>
                {busy && <Loader2 className="size-4 animate-spin" />} Create checkout link
              </Button>
              {created && (
                <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-4" /> {inr(created.amount)} · {created.merchant_order_id}
                  </p>
                  <div className="bg-background flex items-center gap-1 rounded-md border px-2 py-1">
                    <code className="min-w-0 flex-1 truncate text-xs">{created.url}</code>
                    <CopyButton value={created.url} label="Checkout link" />
                    <a href={created.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground p-1" aria-label="Open checkout">
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                </div>
              )}
            </>
          )}
          <p className="text-muted-foreground flex items-start gap-1.5 pt-1 text-[11px]">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> Confirm an order is paid from your server (GET /v1/checkout/sessions/:id or the payment.success webhook), never from the return URL alone.
          </p>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-4 [.border-b]:pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Checkouts</CardTitle>
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList>
                <TabsTrigger value="ALL">All</TabsTrigger>
                <TabsTrigger value="OPEN">Open</TabsTrigger>
                <TabsTrigger value="PAID">Paid</TabsTrigger>
                <TabsTrigger value="EXPIRED">Expired</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isError ? (
            <div className="p-6">
              <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            </div>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-sm">
              <Info className="size-6" /> No checkouts yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Order</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Created</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/30">
                      <td className="max-w-[14rem] px-4 py-3">
                        <p className="truncate font-medium">{s.merchant_order_id}</p>
                        <p className="text-muted-foreground truncate text-xs">{s.description ?? s.customer.email ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(s.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', SESSION_STATUS[s.status])}>{s.status.charAt(0) + s.status.slice(1).toLowerCase()}</span>
                        {s.attempts > 0 && s.status !== 'PAID' && <span className="text-muted-foreground ml-2 text-xs">{s.attempts} attempt{s.attempts === 1 ? '' : 's'}</span>}
                      </td>
                      <td className="text-muted-foreground hidden px-4 py-3 md:table-cell" title={formatDateTime(s.created_at)}>
                        {formatRelative(s.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {s.status === 'OPEN' && <CopyButton value={s.url} label="Checkout link" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.hasNextPage && (
                <div className="border-t p-3 text-center">
                  <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Admin: review merchants' websites. */
export function WebsiteReviews() {
  const qc = useQueryClient();
  const can = useCan();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const q = useQuery({ queryKey: ['admin-websites', status], queryFn: () => api.get<MerchantWebsite[]>('/v1/admin/websites', { status }) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(w: MerchantWebsite, decision: 'APPROVE' | 'REJECT') {
    setBusy(w.id);
    try {
      await api.post(`/v1/admin/websites/${w.id}/review`, { decision, note: notes[w.id]?.trim() || undefined });
      toast.success(decision === 'APPROVE' ? `${w.url} approved` : `${w.url} rejected`);
      await qc.invalidateQueries({ queryKey: ['admin-websites'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
        <TabsList>
          <TabsTrigger value="PENDING">In review</TabsTrigger>
          <TabsTrigger value="APPROVED">Approved</TabsTrigger>
          <TabsTrigger value="REJECTED">Rejected</TabsTrigger>
        </TabsList>
      </Tabs>
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <Skeleton className="h-40" />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">Nothing here.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {(q.data ?? []).map((w) => (
            <div key={w.id} className="bg-card space-y-3 rounded-xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a href={w.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 truncate font-semibold hover:underline">
                    {w.url} <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                  <p className="text-muted-foreground text-xs">
                    <Link href={`/admin/merchants/${w.merchant_id}`} className="hover:underline">
                      {w.merchant_name}
                    </Link>{' '}
                    · added {formatRelative(w.created_at)}
                  </p>
                </div>
                <WebsiteStatus status={w.status} />
              </div>
              {w.review_note && <p className="text-muted-foreground text-xs">“{w.review_note}”</p>}
              {status === 'PENDING' && can('compliance.approve') && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-[11px]">Check that the site is live, belongs to this business, matches its declared category, and shows terms, privacy, refund and contact pages.</p>
                  <Input aria-label="Review note" value={notes[w.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [w.id]: e.target.value }))} placeholder="Note (required to reject)" />
                  <div className="flex gap-2">
                    <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy === w.id} onClick={() => void decide(w, 'APPROVE')}>
                      <CheckCircle2 className="size-4" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="text-destructive" disabled={busy === w.id || !(notes[w.id] ?? '').trim()} onClick={() => void decide(w, 'REJECT')}>
                      <XCircle className="size-4" /> Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
