'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Printer, ReceiptIndianRupee, Save } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { InvoiceDoc, TaxProfile } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const KEY = ['invoices'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Invoice list. `base` is where an invoice opens (/accounts/invoices or /admin/invoices). */
export function InvoiceList({ base, admin = false }: { base: string; admin?: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const [month, setMonth] = useState('');
  const [genMonth, setGenMonth] = useState(lastMonth);
  const [busy, setBusy] = useState(false);
  const list = useInfiniteQuery({
    queryKey: [...KEY, month],
    queryFn: ({ pageParam }) => apiRequest<InvoiceDoc[]>('/v1/invoices', { query: { month: month || undefined, limit: 25, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post<{ month: string; merchants: number; issued: number }>('/v1/admin/invoices/generate', { month: genMonth });
      toast.success(r.issued ? `${r.issued} invoice${r.issued === 1 ? '' : 's'} issued for ${r.month}` : `Nothing new to invoice for ${r.month}`);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="inv-month">Month</Label>
          <Input id="inv-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
        </div>
        {admin && can('settlement.process') && (
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="inv-gen">Issue invoices for</Label>
              <Input id="inv-gen" type="month" value={genMonth} onChange={(e) => setGenMonth(e.target.value)} className="w-44" />
            </div>
            <Button disabled={busy || !genMonth} onClick={() => void generate()}>
              {busy ? <Loader2 className="animate-spin" /> : <ReceiptIndianRupee />} Issue now
            </Button>
          </div>
        )}
      </div>
      <Card className="gap-0 overflow-hidden py-0 shadow-none">
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
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-12 text-center text-sm">
            <FileText className="size-7" /> No invoices{month ? ' for this month' : ' yet'}. They are issued automatically after each month ends.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Invoice</th>
                  {admin && <th className="px-4 py-2.5 font-medium">Merchant</th>}
                  <th className="px-4 py-2.5 font-medium">Period</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fees</th>
                  <th className="px-4 py-2.5 text-right font-medium">GST</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((i) => (
                  <tr key={i.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`${base}/${i.id}`} className="font-mono font-medium hover:underline">
                        {i.number}
                      </Link>
                    </td>
                    {admin && <td className="max-w-[14rem] truncate px-4 py-3">{i.buyer.trade_name}</td>}
                    <td className="px-4 py-3">{i.period.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{inr(i.taxable)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{inr((Number(i.cgst) + Number(i.sgst) + Number(i.igst)).toFixed(2))}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(i.total)}</td>
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
      </Card>
    </div>
  );
}

/** A GST tax invoice laid out for screen and print (Rule 46 particulars). */
export function InvoiceView({ id }: { id: string }) {
  const q = useQuery({ queryKey: [...KEY, 'one', id], queryFn: () => api.get<InvoiceDoc>(`/v1/invoices/${id}`) });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const i = q.data;
  if (!i) return <Skeleton className="h-[600px]" />;
  const tax = (Number(i.cgst) + Number(i.sgst) + Number(i.igst)).toFixed(2);
  return (
    <div className="space-y-4">
      <div className="flex justify-end print:hidden">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer /> Print / save as PDF
        </Button>
      </div>
      <article className="bg-card mx-auto max-w-4xl space-y-6 rounded-xl border p-8 text-sm shadow-sm print:max-w-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div>
            <h1 className="text-xl font-semibold">Tax Invoice</h1>
            <p className="text-muted-foreground text-xs">Original for recipient</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-right">
            <dt className="text-muted-foreground">Invoice no.</dt>
            <dd className="font-mono font-semibold">{i.number}</dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd>{new Date(i.issue_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</dd>
            <dt className="text-muted-foreground">Period</dt>
            <dd>{i.period.label}</dd>
          </dl>
        </header>
        <section className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Supplier</p>
            <p className="font-semibold">{i.seller.legal_name}</p>
            <p className="whitespace-pre-line">{i.seller.address}</p>
            <p>GSTIN: <span className="font-mono">{i.seller.gstin}</span> · PAN: <span className="font-mono">{i.seller.pan}</span></p>
            <p>State: {i.seller.state} ({i.seller.state_code})</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Recipient</p>
            <p className="font-semibold">{i.buyer.name}</p>
            {i.buyer.name !== i.buyer.trade_name && <p>Trade name: {i.buyer.trade_name}</p>}
            {i.buyer.address && <p>{i.buyer.address}</p>}
            <p>GSTIN: <span className="font-mono">{i.buyer.gstin ?? 'Unregistered'}</span></p>
            <p>
              Place of supply: {i.place_of_supply?.state ?? '—'} ({i.place_of_supply?.code ?? '—'})
            </p>
          </div>
        </section>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y text-left text-xs">
              <th className="py-2 pr-2 font-semibold">#</th>
              <th className="py-2 pr-2 font-semibold">Description of service</th>
              <th className="py-2 pr-2 font-semibold">SAC</th>
              <th className="py-2 pr-2 text-right font-semibold">Transactions</th>
              <th className="py-2 pr-2 text-right font-semibold">Taxable value</th>
              <th className="py-2 text-right font-semibold">GST</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={l.code} className="border-b">
                <td className="py-2 pr-2">{n + 1}</td>
                <td className="py-2 pr-2">{l.description}</td>
                <td className="py-2 pr-2 font-mono">{l.sac}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{l.count.toLocaleString('en-IN')}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{inr(l.taxable)}</td>
                <td className="py-2 text-right tabular-nums">{inr(l.tax)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section className="flex flex-wrap justify-between gap-6">
          <div className="text-muted-foreground max-w-sm space-y-1 text-xs">
            <p>Tax is not payable on reverse charge.</p>
            <p>GST was charged on each transaction and already deducted from your settlements; this invoice consolidates it for the month.</p>
            <p>
              For your records: scheme commission credited to you this month {inr(i.commission_credited)} (not part of this invoice). Taxable value for TDS, if applicable: {inr(i.taxable)}.
            </p>
            {i.seller.footer_note && <p>{i.seller.footer_note}</p>}
          </div>
          <dl className="grid min-w-64 grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt>Taxable value</dt>
            <dd className="text-right tabular-nums">{inr(i.taxable)}</dd>
            {i.inter_state ? (
              <>
                <dt>IGST @ 18%</dt>
                <dd className="text-right tabular-nums">{inr(i.igst)}</dd>
              </>
            ) : (
              <>
                <dt>CGST @ 9%</dt>
                <dd className="text-right tabular-nums">{inr(i.cgst)}</dd>
                <dt>SGST @ 9%</dt>
                <dd className="text-right tabular-nums">{inr(i.sgst)}</dd>
              </>
            )}
            <dt className="border-t pt-1 font-semibold">Total (incl. GST {inr(tax)})</dt>
            <dd className="border-t pt-1 text-right font-semibold tabular-nums">{inr(i.total)}</dd>
          </dl>
        </section>
        <footer className="text-muted-foreground flex justify-between border-t pt-4 text-xs">
          <span>This is a computer-generated invoice and does not require a signature.</span>
          <span>For {i.seller.legal_name}</span>
        </footer>
      </article>
      <p className="text-muted-foreground text-center text-xs print:hidden">Issued {formatDateTime(i.created_at)}</p>
    </div>
  );
}

type TaxForm = { legal_name: string; gstin: string; pan: string; address: string; sac: string; invoice_prefix: string; footer_note: string; reason: string };

/** Settings → Tax & invoices: the GST registration printed on every invoice. */
export function TaxProfileSettings() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tax-profile'], queryFn: () => api.get<TaxProfile | null>('/v1/admin/tax-profile') });
  const [form, setForm] = useState<TaxForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <Skeleton className="h-96" />;
  const p = q.data;
  const f: TaxForm = form ?? { legal_name: p?.legal_name ?? '', gstin: p?.gstin ?? '', pan: p?.pan ?? '', address: p?.address ?? '', sac: p?.sac ?? '997159', invoice_prefix: p?.invoice_prefix ?? '', footer_note: p?.footer_note ?? '', reason: '' };
  const set = (k: keyof TaxForm, v: string) => setForm({ ...f, [k]: v });
  const editable = can('system.settings.manage');

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      await api.put('/v1/admin/tax-profile', { ...f, gstin: f.gstin.trim().toUpperCase(), state_code: f.gstin.trim().slice(0, 2), footer_note: f.footer_note.trim() || undefined });
      toast.success('Tax profile saved');
      setForm(null);
      await qc.invalidateQueries({ queryKey: ['tax-profile'] });
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) setErrors(Object.fromEntries(err.details.map((d) => [d.path.split('.')[0]!, d.message])));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof TaxForm, label: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`tp-${k}`}>{label}</Label>
      <Input id={`tp-${k}`} value={f[k]} disabled={!editable} onChange={(e) => set(k, e.target.value)} aria-invalid={Boolean(errors[k])} {...props} />
      {errors[k] && <p className="text-destructive text-xs">{errors[k]}</p>}
    </div>
  );
  return (
    <Card className="max-w-3xl shadow-none">
      <CardHeader>
        <CardTitle>Tax & invoices</CardTitle>
        <CardDescription>
          Printed on each merchant&apos;s monthly GST tax invoice. Invoices are issued automatically after each month ends{p ? '' : ' once this is saved'}; issued invoices never change.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{field('legal_name', 'Legal name', { placeholder: 'Pay Services Private Limited' })}</div>
        {field('gstin', 'GSTIN', { className: 'font-mono uppercase', maxLength: 15 })}
        {field('pan', 'PAN', { className: 'font-mono uppercase', maxLength: 10 })}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tp-address">Registered address</Label>
          <Textarea id="tp-address" rows={3} value={f.address} disabled={!editable} onChange={(e) => set('address', e.target.value)} />
          {errors.address && <p className="text-destructive text-xs">{errors.address}</p>}
        </div>
        {field('sac', 'SAC code', { className: 'font-mono', maxLength: 8 })}
        {field('invoice_prefix', 'Invoice number prefix', { className: 'font-mono uppercase', maxLength: 5, placeholder: 'P2A' })}
        <div className="sm:col-span-2">{field('footer_note', 'Footer note (optional)', { placeholder: 'e.g. Bank details for dues: …' })}</div>
        <p className="text-muted-foreground text-xs sm:col-span-2">
          Numbers look like <span className="font-mono">{(f.invoice_prefix || 'P2A').toUpperCase()}2627-000001</span> and restart each financial year. Confirm the SAC and invoice requirements (including e-invoicing above the turnover limit) with your tax adviser.
        </p>
        {editable && (
          <>
            <div className="sm:col-span-2">{field('reason', 'Reason for the change', { placeholder: 'e.g. Initial setup' })}</div>
            <div className="sm:col-span-2">
              <Button disabled={busy || f.reason.trim().length < 5} onClick={() => void save()}>
                {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
