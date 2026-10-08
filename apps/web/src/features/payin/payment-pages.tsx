'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Loader2, Pencil, Plus, Receipt, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { PaymentQr } from '@/features/payin/payment-qr';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PageField, PageFieldType, PagePaymentRow, PaymentPageRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const KEY = ['payment-pages'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const amountText = (p: PaymentPageRow) => (p.amount.amount_type === 'FIXED' ? inr(p.amount.amount) : `${inr(p.amount.min_amount)} – ${inr(p.amount.max_amount)}`);

/** Payin → Payment pages. */
export function PaymentPages() {
  const can = useCan();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<PaymentPageRow[]>('/v1/payment-pages') });
  const [editing, setEditing] = useState<PaymentPageRow | 'new' | null>(null);
  const [viewing, setViewing] = useState<PaymentPageRow | null>(null);
  const qc = useQueryClient();

  async function toggle(p: PaymentPageRow) {
    try {
      await api.post(`/v1/payment-pages/${p.id}/status`, { status: p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      toast.success(p.status === 'ACTIVE' ? 'Page turned off' : 'Page is live');
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const pages = q.data ?? [];
  return (
    <div className="space-y-4">
      {can('payin.create') && pages.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing('new')}>
            <Plus /> New page
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : pages.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
          <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
            <FileText className="size-6" />
          </span>
          <div>
            <p className="font-medium">No payment pages yet</p>
            <p className="text-muted-foreground max-w-md text-sm">One page, many payers: school or society fees, donations, event tickets, a product. Share the page link or its QR anywhere.</p>
          </div>
          {can('payin.create') && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Create a payment page
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {pages.map((p) => (
            <article key={p.id} className="bg-card flex flex-col rounded-xl border">
              <div className="flex items-start justify-between gap-3 border-b p-4">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{p.title}</h3>
                  <p className="text-muted-foreground truncate font-mono text-xs">/p/{p.slug}</p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs">
                  <span className={p.status === 'ACTIVE' ? 'font-medium text-emerald-600' : 'text-muted-foreground'}>{p.status === 'ACTIVE' ? 'Live' : 'Off'}</span>
                  <Switch checked={p.status === 'ACTIVE'} disabled={!can('payin.create')} onCheckedChange={() => void toggle(p)} aria-label={`Page ${p.title} live`} />
                </label>
              </div>
              <dl className="grid grid-cols-3 gap-2 p-4 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Amount</dt>
                  <dd className="truncate font-medium">{amountText(p)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Payments</dt>
                  <dd className="font-medium tabular-nums">{p.stats?.payments ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Collected</dt>
                  <dd className="font-medium tabular-nums">{inr(p.stats?.collected ?? '0')}</dd>
                </div>
              </dl>
              <p className="text-muted-foreground px-4 text-xs">{p.stats?.last_payment_at ? `Last payment ${formatRelative(p.stats.last_payment_at)}` : 'No payments yet'}</p>
              <div className="mt-auto flex items-center gap-1 border-t p-2">
                <CopyButton value={p.url} label="Page link" />
                <Button asChild variant="ghost" size="icon" className="size-7" aria-label="Open page">
                  <a href={p.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" onClick={() => setViewing(p)}>
                  <Receipt /> Payments
                </Button>
                {can('payin.create') && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    <Pencil /> Edit
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <PageEditor
        page={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: KEY });
        }}
      />
      <PagePayments page={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

type Draft = {
  title: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  amountType: 'FIXED' | 'CUSTOMER';
  amount: string;
  min: string;
  max: string;
  fields: PageField[];
  success: string;
};

function draftOf(p: PaymentPageRow | 'new' | null): Draft {
  if (!p || p === 'new') return { title: '', slug: '', slugTouched: false, description: '', amountType: 'FIXED', amount: '', min: '', max: '', fields: [], success: '' };
  return {
    title: p.title,
    slug: p.slug,
    slugTouched: true,
    description: p.description ?? '',
    amountType: p.amount.amount_type,
    amount: p.amount.amount_type === 'FIXED' ? p.amount.amount : '',
    min: p.amount.amount_type === 'CUSTOMER' ? p.amount.min_amount : '',
    max: p.amount.amount_type === 'CUSTOMER' ? p.amount.max_amount : '',
    fields: p.fields,
    success: p.success_message ?? '',
  };
}

const money = (v: string) => /^\d{1,9}(\.\d{1,2})?$/.test(v) && Number(v) >= 1;

function PageEditor({ page, onClose, onSaved }: { page: PaymentPageRow | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(page));
  const [lastPage, setLastPage] = useState(page);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (page !== lastPage) {
    setLastPage(page);
    setD(draftOf(page));
    setErrors({});
  }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setField = (i: number, patch: Partial<PageField>) => set('fields', d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const amountOk = d.amountType === 'FIXED' ? money(d.amount) : money(d.min) && money(d.max) && Number(d.max) >= Number(d.min);
  const valid = d.title.trim().length >= 3 && /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(d.slug) && amountOk && d.fields.every((f) => f.label.trim());

  async function save() {
    setBusy(true);
    setErrors({});
    const body = {
      slug: d.slug,
      title: d.title.trim(),
      ...(d.description.trim() ? { description: d.description.trim() } : {}),
      ...(d.success.trim() ? { success_message: d.success.trim() } : {}),
      amount: d.amountType === 'FIXED' ? { amount_type: 'FIXED', amount: Number(d.amount).toFixed(2) } : { amount_type: 'CUSTOMER', min_amount: Number(d.min).toFixed(2), max_amount: Number(d.max).toFixed(2) },
      fields: d.fields.map((f, i) => ({ ...f, label: f.label.trim(), key: f.key || slugify(f.label).replace(/-/g, '_').replace(/^[^a-z]+/, '').slice(0, 30) || `field_${i + 1}` })),
    };
    try {
      if (page === 'new') await api.post('/v1/payment-pages', body);
      else if (page) await api.put(`/v1/payment-pages/${page.id}`, body);
      toast.success(page === 'new' ? 'Payment page published' : 'Page updated');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) setErrors(Object.fromEntries(err.details.map((x) => [x.path.split('.')[0]!, x.message])));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={Boolean(page)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{page === 'new' ? 'New payment page' : 'Edit payment page'}</SheetTitle>
          <SheetDescription>A public page where anyone can pay you. Payments land in your account like any other.</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          <div className="space-y-1.5">
            <Label htmlFor="pp-title">Title</Label>
            <Input id="pp-title" value={d.title} maxLength={120} onChange={(e) => setD((x) => ({ ...x, title: e.target.value, slug: x.slugTouched ? x.slug : slugify(e.target.value) }))} placeholder="Annual day — event ticket" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-slug">Page address</Label>
            <div className="flex items-center rounded-md border focus-within:ring-2 focus-within:ring-ring/50">
              <span className="text-muted-foreground border-r px-2.5 py-1.5 text-sm">/p/</span>
              <input id="pp-slug" className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none" value={d.slug} onChange={(e) => setD((x) => ({ ...x, slug: slugify(e.target.value), slugTouched: true }))} placeholder="annual-day-2026" />
            </div>
            {errors.slug ? <p className="text-destructive text-xs">{errors.slug}</p> : <p className="text-muted-foreground text-xs">Lowercase letters, digits and hyphens. Changing it breaks links you already shared.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-desc">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea id="pp-desc" rows={3} maxLength={1000} value={d.description} onChange={(e) => set('description', e.target.value)} placeholder="What payers get, dates, contact details…" />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Amount type">
              {(
                [
                  ['FIXED', 'Fixed amount', 'Everyone pays the same'],
                  ['CUSTOMER', 'Payer decides', 'Donations, part payments'],
                ] as const
              ).map(([v, t, s]) => (
                <button key={v} type="button" role="radio" aria-checked={d.amountType === v} onClick={() => set('amountType', v)} className={cn('rounded-lg border p-3 text-left', d.amountType === v ? 'border-primary bg-primary/5 ring-primary/20 ring-2' : 'hover:border-foreground/20')}>
                  <span className="block text-sm font-medium">{t}</span>
                  <span className="text-muted-foreground block text-xs">{s}</span>
                </button>
              ))}
            </div>
            {d.amountType === 'FIXED' ? (
              <Input aria-label="Amount (₹)" inputMode="decimal" value={d.amount} onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Amount in ₹, e.g. 2500" />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Input aria-label="Minimum (₹)" inputMode="decimal" value={d.min} onChange={(e) => set('min', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Minimum ₹" />
                <Input aria-label="Maximum (₹)" inputMode="decimal" value={d.max} onChange={(e) => set('max', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Maximum ₹" />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Extra details to collect</Label>
              <Button variant="ghost" size="sm" disabled={d.fields.length >= 5} onClick={() => set('fields', [...d.fields, { key: '', label: '', type: 'text', required: false }])}>
                <Plus /> Add field
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">Name, email and mobile are always asked. Add up to 5 more, e.g. “Student name”, “Flat number”.</p>
            {d.fields.map((f, i) => (
              <div key={i} className="grid grid-cols-[1fr_7.5rem_auto_auto] items-center gap-2">
                <Input aria-label={`Field ${i + 1} label`} value={f.label} maxLength={60} onChange={(e) => setField(i, { label: e.target.value, ...(page === 'new' || !f.key ? { key: '' } : {}) })} placeholder="Label" />
                <Select value={f.type} onValueChange={(v) => setField(i, { type: v as PageFieldType })}>
                  <SelectTrigger aria-label={`Field ${i + 1} type`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-1.5 text-xs">
                  <Switch checked={f.required} onCheckedChange={(v) => setField(i, { required: v })} aria-label={`Field ${i + 1} required`} /> Required
                </label>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-8" aria-label={`Remove field ${i + 1}`} onClick={() => set('fields', d.fields.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-success">
              Thank-you message <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input id="pp-success" value={d.success} maxLength={300} onChange={(e) => set('success', e.target.value)} placeholder="Thank you! Your ticket will be emailed within a day." />
          </div>
          {page && page !== 'new' && (
            <div className="flex items-center gap-4 rounded-lg border p-3">
              <PaymentQr payload={page.url} size={96} alt={`QR code for ${page.title}`} />
              <p className="text-muted-foreground text-xs">Print this QR on posters or receipts — it opens the page. Right-click to save it.</p>
            </div>
          )}
          <Button className="w-full" disabled={!valid || busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />} {page === 'new' ? 'Publish page' : 'Save changes'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PagePayments({ page, onClose }: { page: PaymentPageRow | null; onClose: () => void }) {
  const q = useQuery({ queryKey: [...KEY, page?.id, 'payments'], queryFn: () => api.get<PagePaymentRow[]>(`/v1/payment-pages/${page!.id}/payments`), enabled: Boolean(page) });
  const rows = q.data ?? [];
  function exportCsv() {
    if (!page) return;
    const cols = ['paid_at', 'reference', 'amount', 'name', 'email', 'mobile', ...page.fields.map((f) => f.key)];
    const esc = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(','), ...rows.map((r) => [r.paid_at, r.reference, r.amount, r.customer.name, r.customer.email, r.customer.mobile, ...page.fields.map((f) => r.fields[f.key])].map(esc).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `${page.slug}-payments.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Sheet open={Boolean(page)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{page?.title}</SheetTitle>
          <SheetDescription>
            {page?.stats?.payments ?? 0} payments · {inr(page?.stats?.collected ?? '0')} collected
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-6">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={!rows.length} onClick={exportCsv}>
              Download CSV
            </Button>
          </div>
          {q.isLoading ? (
            <Skeleton className="h-40" />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm">
              <Users className="size-6" /> No payments yet. Share the page to start collecting.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {rows.map((r) => (
                <li key={r.checkout_session_id} className="space-y-1 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate font-medium">{r.customer.name ?? '—'}</p>
                    <p className="font-semibold tabular-nums">{inr(r.amount)}</p>
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {[r.customer.email, r.customer.mobile].filter(Boolean).join(' · ')} · <span title={formatDateTime(r.paid_at)}>{formatRelative(r.paid_at)}</span>
                  </p>
                  {page && page.fields.length > 0 && (
                    <p className="text-xs">
                      {page.fields.map((f) => (
                        <span key={f.key} className="bg-muted mr-1.5 inline-block rounded px-1.5 py-0.5">
                          {f.label}: <span className="font-medium">{r.fields[f.key] ?? '—'}</span>
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
