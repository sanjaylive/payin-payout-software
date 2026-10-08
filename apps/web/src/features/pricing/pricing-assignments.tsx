'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Organization, PricingQuote } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { usePricingPlans } from './pricing-plans';

function useSubjects() {
  const resellers = useQuery({ queryKey: ['organizations', 'RESELLER', 'pricing'], queryFn: () => api.list<Organization>('/v1/organizations', { type: 'RESELLER', status: 'ACTIVE', limit: 100 }) });
  return { resellers: resellers.data?.data ?? [] };
}

function AssignCard() {
  const plans = usePricingPlans();
  const { resellers } = useSubjects();
  const [planId, setPlanId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const plan = plans.data?.find((p) => p.id === planId);
  const subjects = resellers.map((r) => ({ id: r.id, name: r.name }));

  async function assign() {
    if (!plan) return;
    setBusy(true);
    try {
      await api.post('/v1/pricing/assignments', { plan_id: plan.id, subject_type: plan.kind === 'WHOLESALE' ? 'RESELLER' : 'MERCHANT', subject_id: subjectId });
      toast.success(`${plan.name} assigned — applies to new transactions from now`);
      setSubjectId('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Assign a plan</CardTitle>
        <CardDescription>Merchant plans go to merchants, wholesale plans to resellers. The previous assignment ends when the new one starts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="assign-plan">Plan</Label>
          <Select value={planId} onValueChange={(v) => { setPlanId(v); setSubjectId(''); }}>
            <SelectTrigger id="assign-plan" className="w-full"><SelectValue placeholder="Choose a plan" /></SelectTrigger>
            <SelectContent>{plans.data?.filter((p) => p.status === 'ACTIVE' && p.kind !== 'PROVIDER_COST').map((p) => <SelectItem key={p.id} value={p.id}>{p.name} ({p.kind === 'WHOLESALE' ? 'wholesale' : 'merchant'})</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="assign-subject">{plan?.kind === 'WHOLESALE' ? 'Reseller' : 'Merchant'}</Label>
          {plan?.kind === 'WHOLESALE' ? (
            <Select value={subjectId} onValueChange={setSubjectId}>
              <SelectTrigger id="assign-subject" className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>{subjects.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <MerchantCombobox value={subjectId || null} onChange={(m) => setSubjectId(m?.id ?? '')} disabled={!plan} />
          )}
        </div>
        <Button disabled={!plan || !subjectId || busy} onClick={() => void assign()}>{busy && <Loader2 className="animate-spin" />} Assign plan</Button>
      </CardContent>
    </Card>
  );
}

function QuoteCard() {
  const [merchantId, setMerchantId] = useState('');
  const [service, setService] = useState<'PAYIN' | 'PAYOUT'>('PAYIN');
  const [amount, setAmount] = useState('1000.00');
  const [quote, setQuote] = useState<PricingQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = merchantId && /^\d{1,10}(\.\d{1,2})?$/.test(amount);

  async function run() {
    setBusy(true);
    try {
      setQuote(await api.post<PricingQuote>('/v1/pricing/quote', { merchant_id: merchantId, service, method: service === 'PAYIN' ? 'UPI_QR' : 'IMPS', amount: amount.includes('.') ? amount : `${amount}.00` }));
    } catch (e) {
      setQuote(null);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string | null][] = quote
    ? [['Merchant fee', quote.merchant_fee], ['GST on fee', quote.tax], ['Wholesale (reseller pays)', quote.wholesale_fee], ['Provider cost', quote.provider_cost], ['Reseller margin', quote.reseller_margin], ['Platform margin', quote.platform_margin]]
    : [];
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Fee calculator</CardTitle>
        <CardDescription>Exactly what a transaction would be charged right now, with the margin split.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <MerchantCombobox value={merchantId || null} onChange={(m) => setMerchantId(m?.id ?? '')} />
          <Select value={service} onValueChange={(v) => setService(v as 'PAYIN' | 'PAYOUT')}>
            <SelectTrigger className="w-full" aria-label="Service"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="PAYIN">Payin (UPI)</SelectItem><SelectItem value="PAYOUT">Payout (IMPS)</SelectItem></SelectContent>
          </Select>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
        </div>
        <Button variant="outline" disabled={!valid || busy} onClick={() => void run()}>{busy ? <Loader2 className="animate-spin" /> : <Calculator />} Calculate</Button>
        {quote && (
          <dl className="divide-y rounded-lg border text-sm">
            {rows.map(([label, v]) => (
              <div key={label} className="flex justify-between px-3 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular font-medium">{fmt(v)}</dd></div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function PricingAssignments() {
  const can = useCan();
  return <div className="grid gap-4 lg:grid-cols-2">{can('pricing.manage') && <AssignCard />}<QuoteCard /></div>;
}
