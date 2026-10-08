'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Lock, ShieldCheck, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PageField, PublicPaymentPage } from '@/lib/api/types';

const inr = (v: string | number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const mobile10 = (v: string) => v.replace(/\D/g, '').slice(-10);

function fieldOk(f: PageField, v: string) {
  if (!v.trim()) return !f.required;
  if (f.type === 'email') return EMAIL.test(v.trim());
  if (f.type === 'phone') return /^[6-9]\d{9}$/.test(mobile10(v));
  if (f.type === 'number') return /^-?\d+(\.\d+)?$/.test(v.trim());
  return true;
}

/** The public payment page (/p/<slug>): collects the payer's details, then opens the hosted checkout. */
export function PublicPaymentPageView({ slug }: { slug: string }) {
  const router = useRouter();
  const q = useQuery({
    queryKey: ['public-page', slug],
    queryFn: () => apiRequest<PublicPaymentPage>(`/v1/public/pages/${encodeURIComponent(slug)}`, { auth: false }).then((r) => r.data),
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  });
  const [amount, setAmount] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.isError) {
    return (
      <Frame>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <XCircle className="size-10 text-rose-500" />
          <h1 className="text-xl font-semibold">This page isn’t available</h1>
          <p className="text-muted-foreground max-w-sm text-sm">{errorMessage(q.error)}</p>
        </div>
      </Frame>
    );
  }
  if (!q.data) {
    return (
      <Frame>
        <div className="grid gap-6 p-6 md:grid-cols-[320px_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </Frame>
    );
  }
  const p = q.data;
  const fixed = p.amount.amount_type === 'FIXED';
  const payable = fixed ? Number(p.amount.amount_type === 'FIXED' ? p.amount.amount : 0) : Number(amount);
  const amountOk = fixed || (/^\d{1,9}(\.\d{1,2})?$/.test(amount) && p.amount.amount_type === 'CUSTOMER' && payable >= Number(p.amount.min_amount) && payable <= Number(p.amount.max_amount));
  const valid = amountOk && name.trim().length >= 2 && EMAIL.test(email.trim()) && /^[6-9]\d{9}$/.test(mobile10(phone)) && p.fields.every((f) => fieldOk(f, answers[f.key] ?? ''));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ token: string }>(`/v1/public/pages/${encodeURIComponent(slug)}/checkout`, {
        method: 'POST',
        auth: false,
        body: {
          ...(fixed ? {} : { amount: payable.toFixed(2) }),
          customer: { name: name.trim(), email: email.trim(), mobile: mobile10(phone) },
          fields: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())),
        },
      });
      router.push(`/checkout/${r.data.token}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Frame>
      <div className="grid md:grid-cols-[340px_1fr]">
        <aside className="bg-primary text-primary-foreground relative flex flex-col gap-5 overflow-hidden p-6 md:p-8">
          <div className="absolute -right-16 -bottom-16 size-56 rounded-full bg-white/10" aria-hidden />
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-white/20 text-lg font-bold">{p.merchant.name.slice(0, 1).toUpperCase()}</span>
            <p className="min-w-0 truncate font-semibold">{p.merchant.name}</p>
          </div>
          <div className="relative">
            <h1 className="text-2xl leading-tight font-semibold">{p.title}</h1>
            {p.description && <p className="mt-3 text-sm whitespace-pre-line opacity-90">{p.description}</p>}
          </div>
          <div className="relative">
            <p className="text-xs opacity-80">{fixed ? 'Amount' : 'Amount range'}</p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums">
              {p.amount.amount_type === 'FIXED' ? inr(p.amount.amount) : `${inr(p.amount.min_amount)} – ${inr(p.amount.max_amount)}`}
            </p>
          </div>
          <p className="relative mt-auto flex items-center gap-1.5 text-[11px] opacity-80">
            <Lock className="size-3" /> Secured by {p.platform.name}
          </p>
        </aside>
        <form
          className="space-y-5 p-6 md:p-8"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void start();
          }}
        >
          <div>
            <h2 className="text-xl font-semibold">Your details</h2>
            <p className="text-muted-foreground text-sm">Your receipt goes to this email.</p>
          </div>
          {!fixed && p.amount.amount_type === 'CUSTOMER' && (
            <div className="space-y-1.5">
              <Label htmlFor="pg-amount">Amount (₹)</Label>
              <Input id="pg-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder={`${p.amount.min_amount} – ${p.amount.max_amount}`} className="text-lg font-semibold" />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pg-name">Full name</Label>
              <Input id="pg-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pg-email">Email</Label>
              <Input id="pg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pg-mobile">Mobile</Label>
              <Input id="pg-mobile" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="10-digit mobile" />
            </div>
            {p.fields.map((f) => (
              <div key={f.key} className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`pg-f-${f.key}`}>
                  {f.label}
                  {!f.required && <span className="text-muted-foreground font-normal"> (optional)</span>}
                </Label>
                <Input
                  id={`pg-f-${f.key}`}
                  type={f.type === 'email' ? 'email' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : f.type === 'phone' ? 'tel' : undefined}
                  value={answers[f.key] ?? ''}
                  aria-invalid={Boolean(answers[f.key]) && !fieldOk(f, answers[f.key] ?? '')}
                  onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
                  maxLength={200}
                />
              </div>
            ))}
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={!valid || busy}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Lock className="size-4" />} {amountOk && payable ? `Pay ${inr(payable)}` : 'Continue to pay'}
          </Button>
          <p className="text-muted-foreground flex items-center gap-1 text-xs">
            <ShieldCheck className="size-3.5" /> Pay by UPI, cards or netbanking on the next step.
          </p>
        </form>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="from-primary/10 via-background to-background flex min-h-dvh items-start justify-center bg-gradient-to-br px-4 py-8 md:items-center">
      <div className="bg-card w-full max-w-4xl overflow-hidden rounded-2xl border shadow-xl">{children}</div>
    </div>
  );
}
