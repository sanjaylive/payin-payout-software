'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardHeader } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, ExternalLink, IndianRupee, Link2, Loader2, Mail, MessageCircle, MessageSquare, Plus, Search, Send, Share2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { PaymentQr } from '@/features/payin/payment-qr';
import { api, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PaymentLinkRow, PaymentLinkSummary } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const KEY = ['payment-links'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newKey = () => `k_${crypto.randomUUID().replace(/-/g, '')}`;

export const LINK_STATUS: Record<PaymentLinkRow['status'], string> = {
  OPEN: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300',
  PAID: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
  EXPIRED: 'bg-muted text-muted-foreground ring-border',
  CANCELLED: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300',
};

function StatusPill({ status }: { status: PaymentLinkRow['status'] }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', LINK_STATUS[status])}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}

/** WhatsApp click-to-chat with the message prefilled (opens WhatsApp; nothing is sent by us). */
function whatsappUrl(l: PaymentLinkRow) {
  const text = `Hi${l.customer.name ? ` ${l.customer.name}` : ''}, please pay ${inr(l.amount)} for ${l.description ?? l.reference}: ${l.url}`;
  const phone = l.customer.mobile?.replace(/\D/g, '').replace(/^(?=[6-9]\d{9}$)/, '91');
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
}

/** Payin → Payment links. */
export function PaymentLinks() {
  const can = useCan();
  const [tab, setTab] = useState<'ALL' | PaymentLinkRow['status']>('ALL');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<PaymentLinkRow | null>(null);
  const [cancelling, setCancelling] = useState<PaymentLinkRow | null>(null);
  const qc = useQueryClient();

  const summary = useQuery({ queryKey: [...KEY, 'summary'], queryFn: () => api.get<PaymentLinkSummary>('/v1/payment-links/summary') });
  const list = useInfiniteQuery({
    queryKey: [...KEY, tab, search],
    queryFn: ({ pageParam }) => apiRequest<PaymentLinkRow[]>('/v1/payment-links', { query: { status: tab === 'ALL' ? undefined : tab, reference: search.trim() || undefined, limit: 20, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  async function cancel(l: PaymentLinkRow) {
    try {
      await api.post(`/v1/payment-links/${l.id}/cancel`);
      toast.success('Link cancelled');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Links created" value={summary.data?.created ?? '—'} icon={Link2} hint="Last 30 days" loading={summary.isLoading} />
        <StatCard label="Paid" value={summary.data?.paid ?? '—'} icon={CheckCircle2} hint="Last 30 days" loading={summary.isLoading} />
        <StatCard label="Collected" value={summary.data ? inr(summary.data.paid_amount) : '—'} icon={IndianRupee} hint="Through links" loading={summary.isLoading} />
        <StatCard label="Awaiting payment" value={summary.data ? inr(summary.data.open_amount) : '—'} icon={Send} hint="Open links" loading={summary.isLoading} />
      </div>

      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-4 [.border-b]:pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList>
                <TabsTrigger value="ALL">All</TabsTrigger>
                <TabsTrigger value="OPEN">Open</TabsTrigger>
                <TabsTrigger value="PAID">Paid</TabsTrigger>
                <TabsTrigger value="EXPIRED">Expired</TabsTrigger>
                <TabsTrigger value="CANCELLED">Cancelled</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex w-full gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-56">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input aria-label="Search by reference" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reference…" className="pl-8" />
              </div>
              {can('payin.create') && (
                <Button onClick={() => setCreating(true)}>
                  <Plus /> New link
                </Button>
              )}
            </div>
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
              <Skeleton className="h-12" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-12 text-center">
              <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
                <Link2 className="size-6" />
              </span>
              <div>
                <p className="font-medium">{tab === 'ALL' && !search ? 'No payment links yet' : 'Nothing matches'}</p>
                <p className="text-muted-foreground text-sm">Request money from anyone — share a link by WhatsApp, SMS, email or QR. No website needed.</p>
              </div>
              {can('payin.create') && tab === 'ALL' && !search && (
                <Button onClick={() => setCreating(true)}>
                  <Plus /> Create your first link
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Link</th>
                    <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Customer</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Created</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((l) => (
                    <tr key={l.id} className="hover:bg-muted/30">
                      <td className="max-w-[16rem] px-4 py-3">
                        <p className="truncate font-medium">{l.description ?? l.reference}</p>
                        <p className="text-muted-foreground truncate font-mono text-xs">{l.reference}</p>
                      </td>
                      <td className="hidden max-w-[12rem] px-4 py-3 lg:table-cell">
                        <p className="truncate">{l.customer.name ?? '—'}</p>
                        <p className="text-muted-foreground truncate text-xs">{l.customer.email ?? l.customer.mobile ?? ''}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(l.amount)}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={l.status} />
                        {l.status === 'PAID' && l.paid_at && <p className="text-muted-foreground mt-0.5 text-xs">{formatRelative(l.paid_at)}</p>}
                        {l.status === 'OPEN' && <p className="text-muted-foreground mt-0.5 text-xs">expires {formatRelative(l.expires_at)}</p>}
                      </td>
                      <td className="text-muted-foreground hidden px-4 py-3 md:table-cell" title={formatDateTime(l.created_at)}>
                        {formatRelative(l.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {l.status === 'OPEN' && (
                            <>
                              <CopyButton value={l.url} label="Payment link" />
                              <Button variant="ghost" size="icon" className="size-7" aria-label="Share" onClick={() => setSharing(l)}>
                                <Share2 className="size-4" />
                              </Button>
                              {can('payin.create') && (
                                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-7" aria-label="Cancel link" onClick={() => setCancelling(l)}>
                                  <Ban className="size-4" />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
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

      <CreateLinkDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(l) => {
          setCreating(false);
          setSharing(l);
          void refresh();
        }}
      />
      <ShareDialog link={sharing} onClose={() => setSharing(null)} onSent={() => void refresh()} />
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this payment link?"
        description="The customer won't be able to pay with it any more."
        confirmLabel="Cancel link"
        destructive
        onConfirm={() => cancelling && void cancel(cancelling)}
      />
    </div>
  );
}

function CreateLinkDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (l: PaymentLinkRow) => void }) {
  const blank = { amount: '', description: '', reference: '', name: '', email: '', mobile: '', days: '7', notifyEmail: true, notifySms: false };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const mobile = f.mobile.replace(/\D/g, '').slice(-10);
  const valid = /^\d{1,9}(\.\d{1,2})?$/.test(f.amount) && Number(f.amount) >= 1 && f.description.trim().length >= 2 && (!f.reference.trim() || /^[A-Za-z0-9_\-/.:]{1,60}$/.test(f.reference.trim()));

  async function create() {
    setBusy(true);
    try {
      const customer = { ...(f.name.trim() ? { name: f.name.trim() } : {}), ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(mobile ? { mobile } : {}) };
      const notify = { email: f.notifyEmail && Boolean(customer.email), sms: f.notifySms && Boolean(customer.mobile) };
      const res = await apiRequest<PaymentLinkRow>('/v1/payment-links', {
        method: 'POST',
        headers: { 'Idempotency-Key': newKey() },
        body: {
          amount: Number(f.amount).toFixed(2),
          description: f.description.trim(),
          ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
          ...(Object.keys(customer).length ? { customer } : {}),
          expires_in_days: Number(f.days),
          notify,
        },
      });
      toast.success(notify.email || notify.sms ? 'Link created and sent' : 'Link created');
      setF(blank);
      onCreated(res.data);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New payment link</DialogTitle>
          <DialogDescription>Your customer pays by UPI or card on a secure page and gets a receipt.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pl-amount">Amount (₹)</Label>
              <Input id="pl-amount" value={f.amount} onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="1,499.00" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pl-ref">
                Reference <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input id="pl-ref" value={f.reference} onChange={(e) => set('reference', e.target.value)} placeholder="INV-204" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-desc">What is it for?</Label>
            <Input id="pl-desc" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={200} placeholder="Invoice INV-204 · October services" />
          </div>
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Customer (optional)</legend>
            <Input aria-label="Customer name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Name" />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Customer email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="Email" />
              <Input aria-label="Customer mobile" inputMode="tel" value={f.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="Mobile" />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-sm">
              <label className={cn('flex items-center gap-2', !f.email.trim() && 'opacity-50')}>
                <Switch checked={f.notifyEmail && Boolean(f.email.trim())} disabled={!f.email.trim()} onCheckedChange={(v) => set('notifyEmail', v)} aria-label="Email the link" /> Email the link
              </label>
              <label className={cn('flex items-center gap-2', mobile.length !== 10 && 'opacity-50')}>
                <Switch checked={f.notifySms && mobile.length === 10} disabled={mobile.length !== 10} onCheckedChange={(v) => set('notifySms', v)} aria-label="SMS the link" /> SMS the link
              </label>
            </div>
          </fieldset>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="pl-days" className="font-normal">
              Link expires after
            </Label>
            <Select value={f.days} onValueChange={(v) => set('days', v)}>
              <SelectTrigger id="pl-days" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['1', '3', '7', '15', '30', '90'].map((d) => (
                  <SelectItem key={d} value={d}>
                    {d} day{d === '1' ? '' : 's'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full" disabled={!valid || busy} onClick={() => void create()}>
            {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Create link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog({ link, onClose, onSent }: { link: PaymentLinkRow | null; onClose: () => void; onSent: () => void }) {
  const can = useCan();
  const [busy, setBusy] = useState<'email' | 'sms' | null>(null);
  async function send(via: 'email' | 'sms') {
    if (!link) return;
    setBusy(via);
    try {
      await api.post(`/v1/payment-links/${link.id}/notify`, { [via]: true });
      toast.success(via === 'email' ? `Emailed to ${link.customer.email}` : `SMS sent to ${link.customer.mobile}`);
      onSent();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open={Boolean(link)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {link && (
          <>
            <DialogHeader>
              <DialogTitle>Share payment link</DialogTitle>
              <DialogDescription>
                {inr(link.amount)} · {link.description ?? link.reference}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3">
              <PaymentQr payload={link.url} size={180} alt="QR code for this payment link" />
              <p className="text-muted-foreground text-xs">Customers can scan this with their phone camera.</p>
            </div>
            <div className="bg-muted/50 flex items-center gap-1 rounded-md border px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate text-xs">{link.url}</code>
              <CopyButton value={link.url} label="Payment link" />
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground p-1" aria-label="Open link">
                <ExternalLink className="size-3.5" />
              </a>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button asChild variant="outline" className="flex-col gap-1 py-6">
                <a href={whatsappUrl(link)} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="size-5 text-emerald-600" />
                  <span className="text-xs">WhatsApp</span>
                </a>
              </Button>
              <Button variant="outline" className="flex-col gap-1 py-6" disabled={!link.customer.email || !can('payin.create') || busy !== null} onClick={() => void send('email')} title={link.customer.email ? undefined : 'No customer email on this link'}>
                {busy === 'email' ? <Loader2 className="size-5 animate-spin" /> : <Mail className="size-5" />}
                <span className="text-xs">Email</span>
              </Button>
              <Button variant="outline" className="flex-col gap-1 py-6" disabled={!link.customer.mobile || !can('payin.create') || busy !== null} onClick={() => void send('sms')} title={link.customer.mobile ? undefined : 'No customer mobile on this link'}>
                {busy === 'sms' ? <Loader2 className="size-5 animate-spin" /> : <MessageSquare className="size-5" />}
                <span className="text-xs">SMS</span>
              </Button>
            </div>
            {link.notified_at && <p className="text-muted-foreground text-center text-xs">Last sent {formatRelative(link.notified_at)}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
