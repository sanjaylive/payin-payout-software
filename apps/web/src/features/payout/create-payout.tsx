'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { payoutFormSchema } from '@pay2all/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock, Loader2, Plus, RotateCcw, Send, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { useBalances } from '@/features/ledger/balance-cards';
import { fmt } from '@/features/ledger/format';
import { keyAfterError, newIdempotencyKey } from '@/features/payin/labels';
import { api } from '@/lib/api/client';
import type { Beneficiary, Payout, PayoutMode } from '@/lib/api/types';
import { useMe } from '@/lib/auth/use-me';
import { AddBeneficiaryDialog, destination } from './beneficiaries';
import { MODE_HINTS, PURPOSE_LABELS } from './labels';
import { usePayout } from './payout-drawer';

type FormValues = z.input<typeof payoutFormSchema>;
const newOrderId = () => `PO-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
const normalise = (v: string) => (v.includes('.') ? `${v.split('.')[0]}.${(v.split('.')[1] + '00').slice(0, 2)}` : `${v}.00`);

function Result({ initial, onReset }: { initial: Payout; onReset: () => void }) {
  const { data } = usePayout(initial.payout_id);
  const p = data ?? initial;
  return (
    <Card className="max-w-lg shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base"><span>{fmt(p.amount)} to {p.beneficiary.name}</span><StatusBadge status={p.status} /></CardTitle>
        <CardDescription className="font-mono text-xs">{p.merchant_order_id} · {p.payout_id}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {p.status === 'APPROVAL_PENDING' ? (
          <p className="flex items-start gap-2"><ShieldCheck className="text-primary mt-0.5 size-5 shrink-0" /> Needs {p.approvals_required} approval{p.approvals_required > 1 ? 's' : ''} from another team member. {fmt(p.total_debit)} is reserved until then.</p>
        ) : p.status === 'SUCCESS' ? (
          <p className="flex items-start gap-2"><CircleCheck className="text-success mt-0.5 size-5 shrink-0" /> Credited. UTR <span className="font-mono">{p.utr}</span></p>
        ) : ['FAILED', 'REJECTED', 'REVERSED'].includes(p.status) ? (
          <p className="text-destructive">{p.failure_reason ?? 'The payout did not complete.'} Funds were returned to your balance.</p>
        ) : (
          <p className="flex items-start gap-2" aria-live="polite"><Clock className="text-muted-foreground mt-0.5 size-5 shrink-0" /> Sending via {p.mode}… {fmt(p.total_debit)} debited (incl. {fmt(p.fee)} fee + {fmt(p.tax)} GST).</p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/payout/transactions">View payouts</Link></Button>
          <Button variant="ghost" onClick={onReset}><RotateCcw /> Make another payout</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function CreatePayout() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const balances = useBalances(me?.organization.type === 'MERCHANT' ? me.organization.id : undefined);
  const beneficiaries = useQuery({ queryKey: ['beneficiaries', 'all-usable'], queryFn: () => api.list<Beneficiary>('/v1/beneficiaries', { limit: 100 }) });
  const usable = (beneficiaries.data?.data ?? []).filter((b) => b.verification_status !== 'BLOCKED' && b.verification_status !== 'FAILED');
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<Payout | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const blank = (): FormValues => ({ merchant_order_id: newOrderId(), amount: '', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary_id: '', narration: '' });
  const form = useForm<FormValues>({ resolver: zodResolver(payoutFormSchema), defaultValues: blank() });
  const e = form.formState.errors;
  const beneficiaryId = useWatch({ control: form.control, name: 'beneficiary_id' });
  const selected = usable.find((b) => b.beneficiary_id === beneficiaryId);
  const modes: PayoutMode[] = selected?.upi_id ? ['UPI'] : ['IMPS', 'NEFT', 'RTGS'];

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const p = await api.post<Payout>(
        '/v1/payouts',
        { merchant_order_id: v.merchant_order_id, amount: normalise(v.amount), mode: v.mode, purpose: v.purpose, beneficiary: { beneficiary_id: v.beneficiary_id }, ...(v.narration ? { narration: v.narration } : {}) },
        { headers: { 'Idempotency-Key': key } },
      );
      setCreated(p);
      await qc.invalidateQueries({ queryKey: ['payouts'] });
      await qc.invalidateQueries({ queryKey: ['balances'] });
    } catch (err) {
      setKey((k) => keyAfterError(err, k));
      setError(err);
    }
  });

  if (created) return <Result initial={created} onReset={() => { setCreated(null); setKey(newIdempotencyKey()); form.reset(blank()); }} />;

  return (
    <Card className="max-w-2xl shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Payout details</CardTitle>
        <CardDescription>
          Available balance: <span className="text-foreground font-medium">{fmt(balances.data?.available)}</span>. The amount plus fee and GST is reserved immediately; larger payouts need another team member’s approval.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(ev) => void submit(ev)} className="space-y-5" noValidate>
          <FormError error={error} />
          <div className="space-y-1.5">
            <Label htmlFor="ben">Beneficiary</Label>
            <div className="flex gap-2">
              <Controller
                control={form.control}
                name="beneficiary_id"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      const b = usable.find((x) => x.beneficiary_id === v);
                      form.setValue('mode', b?.upi_id ? 'UPI' : 'IMPS');
                    }}
                  >
                    <SelectTrigger id="ben" className="w-full" aria-invalid={Boolean(e.beneficiary_id)}><SelectValue placeholder={beneficiaries.isPending ? 'Loading…' : 'Choose a beneficiary'} /></SelectTrigger>
                    <SelectContent>
                      {usable.map((b) => <SelectItem key={b.beneficiary_id} value={b.beneficiary_id}>{b.name} — {destination(b)}{b.verification_status === 'VERIFIED' ? ' ✓' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
              <Button type="button" variant="outline" onClick={() => setAdding(true)}><Plus /> New</Button>
            </div>
            {e.beneficiary_id ? <p className="text-destructive text-xs">{e.beneficiary_id.message}</p> : selected && selected.verification_status !== 'VERIFIED' && <p className="text-muted-foreground text-xs">Not verified yet — payouts above ₹25,000 need a verified beneficiary.</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Amount (₹)" inputMode="decimal" placeholder="15000.00" error={e.amount?.message} {...form.register('amount')} />
            <div className="space-y-1.5">
              <Label htmlFor="mode">Mode</Label>
              <Controller control={form.control} name="mode" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{modes.map((m) => <SelectItem key={m} value={m}>{m} — {MODE_HINTS[m]}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="purpose">Purpose</Label>
              <Controller control={form.control} name="purpose" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="purpose" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(PURPOSE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </div>
            <FormField label="Order ID" hint="Your unique reference; reusing one is rejected." error={e.merchant_order_id?.message} {...form.register('merchant_order_id')} />
          </div>
          <FormField label="Narration (optional)" maxLength={100} placeholder="Invoice 4412" error={e.narration?.message} {...form.register('narration')} />
          <Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <Send />} Make payout</Button>
        </form>
      </CardContent>
      <AddBeneficiaryDialog open={adding} onOpenChange={setAdding} onCreated={(b) => { form.setValue('beneficiary_id', b.beneficiary_id); form.setValue('mode', b.upi_id ? 'UPI' : 'IMPS'); }} />
    </Card>
  );
}
