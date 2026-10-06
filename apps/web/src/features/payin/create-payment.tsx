'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { createPaymentFormSchema } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Copy, Loader2, QrCode, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import type { Payment } from '@/lib/api/types';
import { keyAfterError, METHOD_LABELS, newIdempotencyKey, OPEN_STATUSES } from './labels';
import { copy, SandboxActions, usePayment } from './payment-drawer';
import { PaymentQr } from './payment-qr';

type FormValues = z.input<typeof createPaymentFormSchema>;
type FormOutput = z.output<typeof createPaymentFormSchema>;

const EXPIRY_LABELS: Record<FormValues['expires_in_minutes'], string> = { '5': '5 minutes', '15': '15 minutes', '60': '1 hour', '1440': '24 hours' };
const newOrderId = () => `ORD-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
const normaliseAmount = (v: string) => (v.includes('.') ? `${v.split('.')[0]}.${(v.split('.')[1] + '00').slice(0, 2)}` : `${v}.00`);

function LivePayment({ initial, onReset }: { initial: Payment; onReset: () => void }) {
  const { data } = usePayment(initial.payment_id, { live: true });
  const p = data ?? initial;
  const open = OPEN_STATUSES.includes(p.status);
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{fmt(p.amount)} · {METHOD_LABELS[p.method]}</span>
          <StatusBadge status={p.status} />
        </CardTitle>
        <CardDescription className="font-mono text-xs">{p.merchant_order_id} · {p.payment_id}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {open && p.qr ? (
          <div className="flex flex-col items-center gap-3">
            <PaymentQr payload={p.qr} />
            <p className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite"><Loader2 className="size-4 animate-spin" /> Waiting for payment · expires {formatDateTime(p.expires_at)}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {p.upi_intent && <Button size="sm" variant="outline" onClick={() => copy(p.upi_intent!, 'UPI link')}><Copy /> Copy UPI link</Button>}
              {p.payment_link && <Button size="sm" variant="outline" onClick={() => copy(p.payment_link!, 'Payment link')}><Copy /> Copy payment link</Button>}
            </div>
          </div>
        ) : open ? (
          <p className="text-muted-foreground text-sm" aria-live="polite">The bank hasn’t confirmed this collect request yet. We’ll keep checking; no QR is shown until it’s confirmed, so the customer can’t pay twice.</p>
        ) : p.status === 'SUCCESS' ? (
          <div className="flex items-start gap-3" aria-live="polite">
            <CircleCheck className="text-success mt-0.5 size-6 shrink-0" />
            <div className="text-sm">
              <p className="font-medium">Payment received</p>
              <p className="text-muted-foreground">UTR <span className="font-mono">{p.utr}</span> · net {fmt(p.net_amount)} after {fmt(p.fee)} fee + {fmt(p.tax)} GST</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3" aria-live="polite">
            <CircleX className="text-destructive mt-0.5 size-6 shrink-0" />
            <div className="text-sm">
              <p className="font-medium">Payment {p.status.toLowerCase()}</p>
              <p className="text-muted-foreground">{p.failure_reason ?? 'The customer did not complete the payment.'}</p>
            </div>
          </div>
        )}
        <SandboxActions payment={p} />
        <Button variant="ghost" onClick={onReset}><RotateCcw /> Create another payment</Button>
      </CardContent>
    </Card>
  );
}

export function CreatePayment({ defaultMethod = 'UPI_QR' }: { defaultMethod?: FormValues['method'] }) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<Payment | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Kept across retries of the same submission so a timeout + retry can't create two payments.
  const [key, setKey] = useState(newIdempotencyKey);
  const blank = (): FormValues => ({ merchant_order_id: newOrderId(), amount: '', method: defaultMethod, customer_name: '', customer_mobile: '', customer_email: '', description: '', expires_in_minutes: '15' });
  const form = useForm<FormValues, unknown, FormOutput>({ resolver: zodResolver(createPaymentFormSchema), defaultValues: blank() });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const customer = { ...(v.customer_name ? { name: v.customer_name } : {}), ...(v.customer_mobile ? { mobile: v.customer_mobile } : {}), ...(v.customer_email ? { email: v.customer_email } : {}) };
    try {
      const p = await api.post<Payment>(
        '/v1/payments',
        {
          merchant_order_id: v.merchant_order_id,
          amount: normaliseAmount(v.amount),
          currency: 'INR',
          method: v.method,
          ...(Object.keys(customer).length ? { customer } : {}),
          ...(v.description ? { description: v.description } : {}),
          expires_in_seconds: Number(v.expires_in_minutes) * 60,
        },
        { headers: { 'Idempotency-Key': key } },
      );
      setCreated(p);
      await qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) {
      setKey((k) => keyAfterError(e, k));
      setError(e);
    }
  });

  function reset() {
    setCreated(null);
    setError(null);
    setKey(newIdempotencyKey());
    form.reset(blank());
  }

  if (created) return <div className="max-w-lg"><LivePayment initial={created} onReset={reset} /></div>;

  return (
    <Card className="max-w-2xl shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Payment details</CardTitle>
        <CardDescription>Generates a UPI QR (and intent / link) for your customer. Funds are credited only after the bank confirms.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-5" noValidate>
          <FormError error={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Amount (₹)" inputMode="decimal" placeholder="1000.00" autoFocus error={errors.amount?.message} {...form.register('amount')} />
            <div className="space-y-1.5">
              <Label htmlFor="method">Collect via</Label>
              <Controller
                control={form.control}
                name="method"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="method" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(METHOD_LABELS).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              />
            </div>
            <FormField label="Order ID" hint="Your unique reference; reusing one is rejected." error={errors.merchant_order_id?.message} {...form.register('merchant_order_id')} />
            <div className="space-y-1.5">
              <Label htmlFor="expiry">Expires after</Label>
              <Controller
                control={form.control}
                name="expires_in_minutes"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="expiry" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(EXPIRY_LABELS).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Customer (optional)</legend>
            <FormField label="Name" autoComplete="off" error={errors.customer_name?.message} {...form.register('customer_name')} />
            <FormField label="Mobile" inputMode="tel" autoComplete="off" error={errors.customer_mobile?.message} {...form.register('customer_mobile')} />
            <FormField label="Email" type="email" autoComplete="off" error={errors.customer_email?.message} {...form.register('customer_email')} />
          </fieldset>
          <FormField label="Description (optional)" maxLength={200} error={errors.description?.message} {...form.register('description')} />
          <Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <QrCode />} Create payment</Button>
        </form>
      </CardContent>
    </Card>
  );
}
