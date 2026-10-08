'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, FlaskConical, Loader2, Plus, Printer, QrCode, Receipt, Store, XCircle } from 'lucide-react';
import { toDataURL } from 'qrcode';
import { useState } from 'react';
import { toast } from 'sonner';
import { SANDBOX_TOOLS } from '@/features/payin/labels';
import { PaymentQr } from '@/features/payin/payment-qr';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Payment, StaticQrRow } from '@/lib/api/types';
import { useBrand } from '@/lib/brand/brand-provider';
import { useCan, useMe } from '@/lib/auth/use-me';

const KEY = ['static-qrs'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A print-ready standee (A6 proportions) drawn on a canvas: merchant name, QR, instructions. */
/** The payee name the customer's UPI app will show (pn= in the QR), so the print matches it. */
function payeeName(q: StaticQrRow, fallback: string) {
  try {
    return new URLSearchParams(q.upi_payload!.split('?')[1] ?? '').get('pn') || fallback;
  } catch {
    return fallback;
  }
}

async function standeePng(q: StaticQrRow, fallbackName: string, platform: string): Promise<string> {
  const merchant = payeeName(q, fallbackName);
  const W = 1240;
  const H = 1748;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d4ed8';
  g.fillRect(0, 0, W, 300);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = '600 46px system-ui, sans-serif';
  g.fillText('Scan & pay with any UPI app', W / 2, 130);
  g.font = '400 34px system-ui, sans-serif';
  g.fillText('Google Pay · PhonePe · Paytm · BHIM · bank apps', W / 2, 200);
  const qr = new Image();
  qr.src = await toDataURL(q.upi_payload!, { width: 900, margin: 2, errorCorrectionLevel: 'H' });
  await new Promise((r) => (qr.onload = r));
  g.drawImage(qr, (W - 900) / 2, 380, 900, 900);
  g.fillStyle = '#0f172a';
  g.font = '700 64px system-ui, sans-serif';
  g.fillText(merchant.slice(0, 32), W / 2, 1400);
  g.fillStyle = '#475569';
  g.font = '400 38px system-ui, sans-serif';
  g.fillText(q.label.slice(0, 40), W / 2, 1470);
  g.font = '400 30px system-ui, sans-serif';
  g.fillText('Enter the amount in your app and confirm with your UPI PIN.', W / 2, 1560);
  g.fillStyle = '#94a3b8';
  g.font = '400 26px system-ui, sans-serif';
  g.fillText(`Payments secured by ${platform}`, W / 2, 1680);
  return c.toDataURL('image/png');
}

/** Payin → QR codes → Static QR: printable any-amount QR codes for shop counters. */
export function StaticQrCodes() {
  const can = useCan();
  const brand = useBrand();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<StaticQrRow[]>('/v1/static-qrs'), refetchInterval: 15_000 });
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<StaticQrRow | null>(null);
  const [closing, setClosing] = useState<StaticQrRow | null>(null);
  const [simulating, setSimulating] = useState<StaticQrRow | null>(null);
  const merchant = me?.organization.name ?? 'Merchant';

  async function create() {
    setBusy(true);
    try {
      await api.post('/v1/static-qrs', { label: label.trim() });
      toast.success('QR code ready — download and print it');
      setCreating(false);
      setLabel('');
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function close(row: StaticQrRow) {
    try {
      await api.post(`/v1/static-qrs/${row.id}/close`);
      toast.success(`${row.label} closed`);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setClosing(null);
    }
  }

  async function download(row: StaticQrRow) {
    const url = await standeePng(row, merchant, brand.product_name);
    Object.assign(document.createElement('a'), { href: url, download: `qr-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` }).click();
  }

  async function print(row: StaticQrRow) {
    const url = await standeePng(row, merchant, brand.product_name);
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) return toast.error('Allow pop-ups to print');
    w.document.title = row.label;
    const img = w.document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;max-width:105mm;display:block;margin:auto';
    w.document.body.appendChild(img);
    img.onload = () => w.print();
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const closed = rows.filter((r) => r.status === 'CLOSED');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-gradient-to-r from-sky-500/5 to-transparent p-4">
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Store className="size-5" />
          </span>
          <div>
            <p className="font-medium">Static QR for your counter</p>
            <p className="text-muted-foreground max-w-xl text-sm">Print once, use forever. Customers scan, type the amount and pay from any UPI app; each payment appears here and in your transactions, with a webhook if you use the API.</p>
          </div>
        </div>
        {can('payin.create') && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New static QR
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : active.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm">
          <QrCode className="size-7" /> No active static QR codes.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {active.map((r) => (
            <article key={r.id} className="bg-card flex flex-col items-center gap-3 rounded-xl border p-5 text-center">
              <div className="w-full text-left">
                <h3 className="truncate font-semibold">{r.label}</h3>
                <p className="text-muted-foreground text-xs">Created {formatRelative(r.created_at)}</p>
              </div>
              {r.upi_payload ? (
                <PaymentQr payload={r.upi_payload} size={176} alt={`Static UPI QR ${r.label}`} />
              ) : r.image_url ? (
                <a href={r.image_url} target="_blank" rel="noopener noreferrer" className="text-primary flex h-44 items-center gap-1 text-sm hover:underline">
                  Open QR image <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              <div className="grid w-full grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3 text-left">
                <div>
                  <p className="text-muted-foreground text-xs">Today</p>
                  <p className="font-semibold tabular-nums">{inr(r.today?.amount ?? '0')}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Payments</p>
                  <p className="font-semibold tabular-nums">{r.today?.count ?? 0}</p>
                </div>
              </div>
              <div className="flex w-full flex-wrap justify-center gap-1">
                {r.upi_payload && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => void download(r)}>
                      <Download /> Standee
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void print(r)}>
                      <Printer /> Print
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => setViewing(r)}>
                  <Receipt /> Payments
                </Button>
              </div>
              <div className="flex w-full items-center justify-between border-t pt-2">
                {SANDBOX_TOOLS && r.provider?.startsWith('mock') ? (
                  <Button variant="ghost" size="sm" className="text-amber-600" onClick={() => setSimulating(r)}>
                    <FlaskConical /> Simulate payment
                  </Button>
                ) : (
                  <span />
                )}
                {can('payin.create') && (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setClosing(r)}>
                    <XCircle /> Close
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {closed.length > 0 && (
        <details className="rounded-xl border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">Closed QR codes ({closed.length})</summary>
          <ul className="mt-2 divide-y text-sm">
            {closed.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <span>{r.label}</span>
                <span className="text-muted-foreground text-xs">closed {r.closed_at ? formatRelative(r.closed_at) : ''}</span>
                <Button variant="ghost" size="sm" onClick={() => setViewing(r)}>
                  Payments
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New static QR</DialogTitle>
            <DialogDescription>Name it after where it will be displayed.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim().length >= 2) void create();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="sqr-label">Label</Label>
              <Input id="sqr-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Counter 1 · MG Road store" autoFocus />
            </div>
            <Button type="submit" className="w-full" disabled={label.trim().length < 2 || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <QrCode />} Create QR code
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <QrPayments qr={viewing} onClose={() => setViewing(null)} />
      <SimulateDialog qr={simulating} onClose={() => setSimulating(null)} onDone={() => void qc.invalidateQueries({ queryKey: KEY })} />
      <ConfirmDialog
        open={Boolean(closing)}
        onOpenChange={(o) => !o && setClosing(null)}
        title={`Close “${closing?.label ?? ''}”?`}
        description="The QR stops accepting payments at the bank. Take printed copies down — a closed QR can't be reopened."
        confirmLabel="Close QR code"
        destructive
        onConfirm={() => closing && void close(closing)}
      />
    </div>
  );
}

function QrPayments({ qr, onClose }: { qr: StaticQrRow | null; onClose: () => void }) {
  const q = useQuery({ queryKey: [...KEY, qr?.id, 'payments'], queryFn: () => api.get<Payment[]>(`/v1/static-qrs/${qr!.id}/payments`), enabled: Boolean(qr), refetchInterval: 10_000 });
  return (
    <Sheet open={Boolean(qr)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{qr?.label}</SheetTitle>
          <SheetDescription>Latest payments received on this QR code.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {q.isLoading ? (
            <Skeleton className="h-40" />
          ) : (q.data ?? []).length === 0 ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No payments yet.</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {(q.data ?? []).map((p) => (
                <li key={p.payment_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.payer_vpa ?? 'UPI payment'}</p>
                    <p className="text-muted-foreground truncate text-xs" title={formatDateTime(p.created_at)}>
                      {formatRelative(p.created_at)}
                      {p.utr ? ` · UTR ${p.utr}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{inr(p.amount)}</p>
                    <p className={cn('text-xs', p.status === 'SUCCESS' || p.status === 'SETTLED' ? 'text-emerald-600' : 'text-muted-foreground')}>{p.status.replace('_', ' ').toLowerCase()}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SimulateDialog({ qr, onClose, onDone }: { qr: StaticQrRow | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('250');
  const [busy, setBusy] = useState(false);
  async function pay() {
    if (!qr) return;
    setBusy(true);
    try {
      await api.post(`/v1/sandbox/static-qrs/${qr.id}/pay`, { amount: Number(amount).toFixed(2) });
      toast.success(`Sandbox payment of ${inr(amount)} received`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(qr)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Simulate a customer payment</DialogTitle>
          <DialogDescription>Sandbox only: sends a signed provider callback, exactly like a real payment would.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="sqr-sim">Amount (₹)</Label>
          <Input id="sqr-sim" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <Button disabled={busy || !(Number(amount) >= 1)} onClick={() => void pay()}>
          {busy && <Loader2 className="animate-spin" />} Pay {amount ? inr(amount) : ''}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
