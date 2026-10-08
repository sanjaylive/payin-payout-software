'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { describeRule } from '@/features/pricing/pricing-plans';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PricingPlanRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

export function RateCards() {
  const can = useCan();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['pricing-plans'], queryFn: () => api.get<PricingPlanRow[]>('/v1/pricing/plans') });
  const wholesale = plans.data?.find((p) => p.kind === 'WHOLESALE');
  const cards = (plans.data ?? []).filter((p) => p.kind === 'MERCHANT');
  const [form, setForm] = useState({ name: '', payin: '0.20', payout: '6.00', isDefault: false });
  const [assign, setAssign] = useState({ plan: '', merchant: '' });
  const [busy, setBusy] = useState(false);
  const manage = can('pricing.manage');

  async function create() {
    setBusy(true);
    try {
      await api.post('/v1/pricing/plans', { name: form.name.trim(), kind: 'MERCHANT', is_default: form.isDefault, rules: [{ service: 'PAYIN', charge_type: 'PERCENTAGE', rate: form.payin }, { service: 'PAYOUT', charge_type: 'FLAT', flat_fee: form.payout.includes('.') ? form.payout : `${form.payout}.00` }] });
      toast.success('Rate card created');
      setForm((f) => ({ ...f, name: '' }));
      await qc.invalidateQueries({ queryKey: ['pricing-plans'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function doAssign() {
    setBusy(true);
    try {
      await api.post('/v1/pricing/assignments', { plan_id: assign.plan, subject_type: 'MERCHANT', subject_id: assign.merchant });
      toast.success('Rate card assigned — applies to new transactions from now');
      setAssign({ plan: '', merchant: '' });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Your wholesale price</CardTitle>
          <CardDescription>What Pay2All charges you. Your margin on every transaction is your merchant fee minus this; your rate cards can’t go below it.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">{wholesale ? <ul>{wholesale.rules.map((r) => <li key={r.id}>{describeRule(r)}</li>)}</ul> : <p className="text-muted-foreground">Not set yet — contact Pay2All.</p>}</CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-base">Your rate cards</CardTitle><CardDescription>Merchants without an assigned card use your default card, or Pay2All’s standard pricing.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {cards.length === 0 ? <p className="text-muted-foreground text-sm">No rate cards yet.</p> : (
            <ul className="divide-y rounded-lg border">{cards.map((p) => <li key={p.id} className="px-4 py-3 text-sm"><p className="font-medium">{p.name}{p.is_default ? ' · default' : ''}{p.status !== 'ACTIVE' ? ' · archived' : ''}</p><ul className="text-muted-foreground">{p.rules.map((r) => <li key={r.id}>{describeRule(r)}</li>)}</ul></li>)}</ul>
          )}
          {manage && (
            <div className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-5">
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="rc-name">New card name</Label><Input id="rc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Retail standard" /></div>
              <div className="space-y-1.5"><Label htmlFor="rc-payin">Payin %</Label><Input id="rc-payin" inputMode="decimal" value={form.payin} onChange={(e) => setForm({ ...form, payin: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="rc-payout">Payout ₹</Label><Input id="rc-payout" inputMode="decimal" value={form.payout} onChange={(e) => setForm({ ...form, payout: e.target.value })} /></div>
              <label className="flex items-end gap-2 pb-2 text-sm"><Switch checked={form.isDefault} onCheckedChange={(v) => setForm({ ...form, isDefault: v })} /> Default</label>
              <div className="sm:col-span-5"><Button disabled={form.name.trim().length < 2 || busy} onClick={() => void create()}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Create rate card</Button></div>
            </div>
          )}
        </CardContent>
      </Card>
      {manage && cards.length > 0 && (
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-base">Assign to a merchant</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <Select value={assign.plan} onValueChange={(v) => setAssign({ ...assign, plan: v })}>
              <SelectTrigger className="w-56" aria-label="Rate card"><SelectValue placeholder="Rate card" /></SelectTrigger>
              <SelectContent>{cards.filter((p) => p.status === 'ACTIVE').map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
            <MerchantCombobox value={assign.merchant || null} onChange={(m) => setAssign({ ...assign, merchant: m?.id ?? '' })} className="w-56" />
            <Button disabled={!assign.plan || !assign.merchant || busy} onClick={() => void doAssign()}>Assign</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
