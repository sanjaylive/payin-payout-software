'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, CheckCircle2, Clock3, CreditCard, Loader2, Lock, QrCode, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PaymentQr } from '@/features/payin/payment-qr';
import { API_URL, ApiError, apiRequest } from '@/lib/api/client';
import { colorVars } from '@/lib/brand/brand';
import { errorMessage } from '@/lib/api/errors';
import type { PublicCheckout, PublicCheckoutPayment } from '@/lib/api/types';

const OPEN = ['CREATED', 'PENDING'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function useCountdown(until: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  const s = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return { seconds: s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
}

/**
 * Popup checkout (checkout.js): the page runs in a window the merchant's site opened. The flag
 * survives gateway round-trips in sessionStorage (same window), and the result goes back to the
 * opener only at the merchant's approved website origin.
 */
function useEmbedded(token: string, requested: boolean) {
  const [embedded] = useState(() => {
    const key = `p2a_embed_${token}`;
    try {
      if (requested) sessionStorage.setItem(key, '1');
      return requested || sessionStorage.getItem(key) === '1';
    } catch {
      return requested;
    }
  });
  return embedded && typeof window !== 'undefined' && Boolean(window.opener);
}

function notifyOpener(d: PublicCheckout, status: string): boolean {
  if (!d.embed_origin || !window.opener) return false;
  try {
    (window.opener as Window).postMessage(
      { source: 'pay2all', type: 'checkout.result', status, checkout_session_id: d.id, merchant_order_id: d.order.id, payment_id: status === 'PAID' ? (d.payment?.id ?? null) : null },
      d.embed_origin,
    );
    return true;
  } catch {
    return false;
  }
}

/** The customer-facing hosted checkout (docs/CHECKOUT.md). Public; addressed by the session token. */
export function HostedCheckout({ token, returned, embed = false }: { token: string; returned: boolean; embed?: boolean }) {
  const embedded = useEmbedded(token, embed);
  const qc = useQueryClient();
  const key = ['public-checkout', token];
  const q = useQuery({
    queryKey: key,
    queryFn: () => apiRequest<PublicCheckout>(`/v1/public/checkout/${token}`, { auth: false }).then((r) => r.data),
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    // Poll while a payment is in flight: the result arrives by webhook or the gateway return.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.status === 'OPEN' && d.payment && OPEN.includes(d.payment.status) ? 3000 : false;
    },
  });
  const [choosing, setChoosing] = useState(false);
  const finalStatus = q.data && q.data.status !== 'OPEN' ? q.data.status : null;
  useEffect(() => {
    if (!embedded || !finalStatus || !q.data) return;
    if (!notifyOpener(q.data, finalStatus)) return;
    const t = setTimeout(() => window.close(), finalStatus === 'PAID' ? 2500 : 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per final status
  }, [embedded, finalStatus]);

  if (q.isError) {
    return (
      <Shell>
        <Center icon={<XCircle className="size-10 text-rose-500" />} title="This payment link isn’t valid" text={errorMessage(q.error)} />
      </Shell>
    );
  }
  if (!q.data) {
    return (
      <Shell>
        <div className="grid gap-6 p-6 md:grid-cols-[320px_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </Shell>
    );
  }
  const d = q.data;
  const p = d.payment;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  let body: React.ReactNode;
  if (d.status === 'PAID') body = <Paid d={d} embedded={embedded} />;
  else if (d.status === 'EXPIRED' || d.status === 'CANCELLED') {
    body = (
      <Center
        icon={<Clock3 className="text-muted-foreground size-10" />}
        title={d.status === 'EXPIRED' ? 'This payment link has expired' : 'This payment was cancelled'}
        text={d.kind === 'LINK' ? `No money was taken. Ask ${d.merchant.name} for a new payment link.` : d.kind === 'PAGE' ? 'No money was taken. You can start again.' : 'No money was taken. Go back to the merchant to start again.'}
        action={
          d.return_url ? (
            <Button onClick={() => window.location.assign(d.return_url!)}>Return to {d.merchant.name}</Button>
          ) : d.page ? (
            <Button asChild>
              <a href={`/p/${d.page.slug}`}>Start again</a>
            </Button>
          ) : null
        }
      />
    );
  } else if (p && OPEN.includes(p.status) && p.method === 'UPI_QR' && !choosing) body = <UpiWait p={p} onBack={() => setChoosing(true)} />;
  else if (p && OPEN.includes(p.status) && p.method === 'PAYMENT_LINK' && returned && !choosing) body = <GatewayWait onRetry={() => setChoosing(true)} />;
  else body = <Choose d={d} token={token} embedded={embedded} failed={p && (p.status === 'FAILED' || p.status === 'EXPIRED') ? p : null} onStarted={() => { setChoosing(false); void refresh(); }} />;

  return (
    <Shell color={d.brand?.primary_color}>
      <div className="grid md:grid-cols-[340px_1fr]">
        <Summary d={d} />
        <div className="min-h-[460px] p-6 md:p-8">{body}</div>
      </div>
    </Shell>
  );
}

export function Shell({ children, color }: { children: React.ReactNode; color?: string | null }) {
  return (
    <div
      data-brand-scope=""
      {...(color ? { 'data-brand-color': '' } : {})}
      style={colorVars(color ?? null) as React.CSSProperties}
      className="from-primary/10 via-background to-background flex min-h-dvh items-start justify-center bg-gradient-to-br px-4 py-8 md:items-center"
    >
      <div className="bg-card w-full max-w-4xl overflow-hidden rounded-2xl border shadow-xl">{children}</div>
    </div>
  );
}

function Summary({ d }: { d: PublicCheckout }) {
  const t = useCountdown(d.status === 'OPEN' ? d.expires_at : null);
  return (
    <aside className="bg-primary text-primary-foreground relative flex flex-col gap-6 overflow-hidden p-6 md:p-8">
      <div className="absolute -right-16 -bottom-16 size-56 rounded-full bg-white/10" aria-hidden />
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl bg-white/20 text-lg font-bold">{d.merchant.name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <p className="text-xs opacity-80">Paying</p>
          <p className="truncate font-semibold">{d.merchant.name}</p>
        </div>
      </div>
      <div>
        <p className="text-xs opacity-80">Amount</p>
        <p className="text-4xl font-semibold tracking-tight tabular-nums">{inr(d.order.amount)}</p>
        {d.order.description && <p className="mt-2 text-sm opacity-90">{d.order.description}</p>}
      </div>
      <dl className="relative space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="opacity-75">{d.kind === 'CHECKOUT' ? 'Order' : 'Reference'}</dt>
          <dd className="truncate font-mono">{d.order.id}</dd>
        </div>
        {t && (
          <div className="flex justify-between gap-2">
            <dt className="opacity-75">Link expires in</dt>
            <dd className={cn('font-mono tabular-nums', t.seconds < 120 && 'font-semibold')}>{t.text}</dd>
          </div>
        )}
      </dl>
      <p className="relative mt-auto flex items-center gap-1.5 text-[11px] opacity-80">
        <Lock className="size-3" /> Secured by{' '}
        {d.brand?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- brand image served by the API
          <img src={`${API_URL}${d.brand.logo_url}`} alt={d.brand.name} className="h-4 max-w-28 rounded-sm bg-white/90 object-contain px-1" />
        ) : (
          (d.brand?.name ?? d.platform.name)
        )}
      </p>
    </aside>
  );
}

function Center({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
      {icon}
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{text}</p>
      {action}
    </div>
  );
}

function Choose({ d, token, embedded, failed, onStarted }: { d: PublicCheckout; token: string; embedded: boolean; failed: PublicCheckoutPayment | null; onStarted: () => void }) {
  const [name, setName] = useState(d.customer.name ?? '');
  const [email, setEmail] = useState(d.customer.email ?? '');
  const [mobile, setMobile] = useState(d.customer.mobile ?? '');
  const [method, setMethod] = useState<'UPI' | 'GATEWAY' | null>(d.methods.upi ? 'UPI' : d.methods.gateways.length ? 'GATEWAY' : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && /^[6-9]\d{9}$/.test(mobile.replace(/\D/g, '').slice(-10)) && method;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<PublicCheckoutPayment>(`/v1/public/checkout/${token}/pay`, { method: 'POST', auth: false, body: { method, customer: { name: name.trim(), email: email.trim(), mobile: mobile.replace(/\D/g, '').slice(-10) } } });
      const res = r.data;
      if (method === 'GATEWAY') {
        // Hand over to the gateway: a plain redirect, or our hand-off page for form-post / script gateways.
        const target = res.action?.type === 'REDIRECT' ? res.action.url : res.payment_link;
        if (target) return window.location.assign(target);
        setError('The payment page could not be opened. Please try again.');
        setBusy(false);
        return;
      }
      onStarted();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  const none = !d.methods.upi && d.methods.gateways.length === 0;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Complete your payment</h1>
        <p className="text-muted-foreground text-sm">Enter your details and choose how to pay.</p>
      </div>
      {failed && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{failed.status === 'EXPIRED' ? 'The last attempt timed out.' : `The last attempt failed${failed.failure_reason ? `: ${failed.failure_reason}` : '.'}`} No money was taken — you can try again.</span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="co-name">Full name</Label>
          <Input id="co-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-email">Email</Label>
          <Input id="co-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-mobile">Mobile</Label>
          <Input id="co-mobile" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} autoComplete="tel" placeholder="10-digit mobile" />
        </div>
      </div>
      <div className="space-y-2" role="radiogroup" aria-label="Payment method">
        <Label>Pay with</Label>
        {none && <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">Online payments are unavailable right now. Please try again later.</p>}
        {d.methods.upi && (
          <MethodCard selected={method === 'UPI'} onSelect={() => setMethod('UPI')} icon={<QrCode className="size-5" />} title="UPI" text="Scan a QR or pay in GPay, PhonePe, Paytm or any UPI app" />
        )}
        {d.methods.gateways.map((g) => (
          <MethodCard key={g.key} selected={method === 'GATEWAY'} onSelect={() => setMethod('GATEWAY')} icon={<CreditCard className="size-5" />} title={g.name} text={`Credit & debit cards, netbanking${g.methods.includes('WALLET') ? ', wallets' : ''}${g.methods.includes('EMI') ? ' and EMI' : ''} on a secure payment page`} />
        ))}
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button size="lg" className="h-12 w-full text-base" disabled={!valid || busy || none} onClick={() => void pay()}>
        {busy ? <Loader2 className="size-5 animate-spin" /> : <Lock className="size-4" />} Pay {inr(d.order.amount)}
      </Button>
      <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="size-3.5" /> Your card details are entered only on the bank’s secure page.
        </span>
        {d.cancel_url && (
          <a
            href={d.cancel_url}
            onClick={(e) => {
              e.preventDefault();
              void apiRequest(`/v1/public/checkout/${token}/cancel`, { method: 'POST', auth: false, body: {} }).finally(() => {
                if (embedded && notifyOpener(d, 'CANCELLED')) window.close();
                else window.location.assign(d.cancel_url!);
              });
            }}
            className="hover:text-foreground shrink-0 underline-offset-2 hover:underline">
            Cancel
          </a>
        )}
      </div>
    </div>
  );
}

function MethodCard({ selected, onSelect, icon, title, text }: { selected: boolean; onSelect: () => void; icon: React.ReactNode; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className={cn('flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all', selected ? 'border-primary bg-primary/5 ring-primary/20 ring-2' : 'hover:border-foreground/20')}>
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{text}</span>
      </span>
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary' : 'border-muted-foreground/40')}>{selected && <span className="bg-primary size-2 rounded-full" />}</span>
    </button>
  );
}

function UpiWait({ p, onBack }: { p: PublicCheckoutPayment; onBack: () => void }) {
  const t = useCountdown(p.expires_at);
  const link = p.upi_intent ?? p.qr_payload;
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div>
        <h1 className="text-xl font-semibold">Scan to pay with UPI</h1>
        <p className="text-muted-foreground text-sm">Open any UPI app and scan this code. The amount is filled in.</p>
      </div>
      {p.qr_payload && <PaymentQr payload={p.qr_payload} size={232} />}
      {link && (
        <Button asChild size="lg" className="w-full max-w-xs md:hidden">
          <a href={link}>
            <Smartphone className="size-4" /> Pay in UPI app
          </a>
        </Button>
      )}
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Waiting for your payment{t ? ` · ${t.text}` : ''}
      </div>
      <p className="text-muted-foreground max-w-sm text-xs">Keep this page open. It updates by itself once your bank confirms.</p>
      <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" /> Pay another way
      </button>
    </div>
  );
}

function GatewayWait({ onRetry }: { onRetry: () => void }) {
  return (
    <Center
      icon={<Loader2 className="text-primary size-10 animate-spin" />}
      title="Confirming your payment…"
      text="We’re checking with the bank. This usually takes a few seconds — please don’t pay again."
      action={
        <button type="button" onClick={onRetry} className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline">
          The payment didn’t go through? Try again
        </button>
      }
    />
  );
}

function Paid({ d, embedded }: { d: PublicCheckout; embedded: boolean }) {
  const [deadline] = useState(() => Date.now() + 6000);
  useEffect(() => {
    // In a popup the merchant's page takes over (the window closes itself).
    if (!d.return_url || embedded) return;
    const id = setTimeout(() => window.location.assign(d.return_url!), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(id);
  }, [d.return_url, deadline, embedded]);
  const icon = (
    <span className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10">
      <CheckCircle2 className="size-10 text-emerald-600" />
    </span>
  );
  if (d.return_url) {
    return (
      <Center
        icon={icon}
        title="Payment successful"
        text={`${inr(d.order.amount)} paid to ${d.merchant.name}${d.payment?.utr ? ` · Ref ${d.payment.utr}` : ''}. ${embedded ? 'This window will close…' : 'Taking you back to the merchant…'}`}
        action={<Button onClick={() => window.location.assign(d.return_url!)}>Return to {d.merchant.name}</Button>}
      />
    );
  }
  // Payment links and pages end here: a receipt the customer can print or save.
  const rows: [string, string][] = [
    ['Paid to', d.merchant.name],
    ['Amount', inr(d.order.amount)],
    ['For', d.order.description ?? '—'],
    ['Reference', d.order.id],
    ...(d.payment?.utr ? ([['Bank reference (UTR)', d.payment.utr]] as [string, string][]) : []),
    ['Date', new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })],
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-6 text-center">
      {icon}
      <div>
        <h1 className="text-xl font-semibold">Payment successful</h1>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">{d.page?.success_message ?? 'Thank you. Keep this receipt for your records — you can close this page.'}</p>
      </div>
      <dl className="w-full max-w-sm divide-y rounded-xl border text-left text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
        Print receipt
      </Button>
    </div>
  );
}
