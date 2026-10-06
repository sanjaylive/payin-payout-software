'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { EmptyState, ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Tags } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PricingPlanRow, PricingRuleRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

export const KIND_LABELS: Record<PricingPlanRow['kind'], { title: string; description: string }> = {
  MERCHANT: { title: 'Merchant pricing', description: 'What merchants are charged per transaction.' },
  WHOLESALE: { title: 'Reseller wholesale', description: 'What resellers pay Pay2All; their margin is merchant fee minus wholesale.' },
  PROVIDER_COST: { title: 'Provider cost', description: 'What providers charge Pay2All (used for margin reporting and reconciliation).' },
};

export function describeRule(r: PricingRuleRow): string {
  const scope = [r.service === 'PAYIN' ? 'Payin' : 'Payout', r.method?.replace(/_/g, ' '), r.provider_id ? 'specific provider' : null].filter(Boolean).join(' · ');
  const slab = r.min_amount || r.max_amount ? ` (${r.min_amount ? fmt(r.min_amount) : '₹0'} – ${r.max_amount ? fmt(r.max_amount) : 'any'})` : '';
  const charge =
    r.charge_type === 'FLAT'
      ? `${fmt(r.flat_fee)} flat`
      : r.charge_type === 'PERCENTAGE'
        ? `${r.rate}%`
        : `${r.rate}% (min ${fmt(r.min_fee)}, max ${fmt(r.max_fee)})`;
  return `${scope}${slab}: ${charge}`;
}

const RATE = /^\d{1,3}(\.\d{1,6})?$/;
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

function CreatePlanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PricingPlanRow['kind']>('MERCHANT');
  const [payinRate, setPayinRate] = useState('0.18');
  const [payoutFlat, setPayoutFlat] = useState('5.00');
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length >= 2 && RATE.test(payinRate) && AMOUNT.test(payoutFlat);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/v1/pricing/plans', {
        name: name.trim(),
        kind,
        is_default: isDefault,
        rules: [
          { service: 'PAYIN', charge_type: 'PERCENTAGE', rate: payinRate },
          { service: 'PAYOUT', charge_type: 'FLAT', flat_fee: payoutFlat.includes('.') ? payoutFlat : `${payoutFlat}.00` },
        ],
      });
      toast.success('Pricing plan created');
      onOpenChange(false);
      setName('');
      await qc.invalidateQueries({ queryKey: ['pricing-plans'] });
    } catch (e) {
      toast.error(e instanceof ApiError && e.details?.length ? e.details.map((d) => d.message).join('; ') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New pricing plan</DialogTitle>
          <DialogDescription>Plans are never edited in place — create a new plan and assign it. Past transactions keep the pricing they were charged.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="plan-name">Name</Label><Input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Enterprise 2026" /></div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-kind">Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as PricingPlanRow['kind'])}>
              <SelectTrigger id="plan-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(KIND_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><Label htmlFor="payin-rate">Payin rate (%)</Label><Input id="payin-rate" inputMode="decimal" value={payinRate} onChange={(e) => setPayinRate(e.target.value)} aria-invalid={!RATE.test(payinRate)} /></div>
            <div className="space-y-1.5"><Label htmlFor="payout-flat">Payout fee (₹ flat)</Label><Input id="payout-flat" inputMode="decimal" value={payoutFlat} onChange={(e) => setPayoutFlat(e.target.value)} aria-invalid={!AMOUNT.test(payoutFlat)} /></div>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm"><span>Make this the default {KIND_LABELS[kind].title.toLowerCase()} plan<span className="text-muted-foreground block text-xs">Applies to everyone without an assigned plan.</span></span><Switch checked={isDefault} onCheckedChange={setIsDefault} /></label>
          <p className="text-muted-foreground text-xs">GST at 18% is added on the fee. Method-, provider- and slab-specific rules can be added through the pricing API.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Create plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function usePricingPlans() {
  return useQuery({ queryKey: ['pricing-plans'], queryFn: () => api.get<PricingPlanRow[]>('/v1/pricing/plans') });
}

export function PricingPlans() {
  const can = useCan();
  const qc = useQueryClient();
  const plans = usePricingPlans();
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<PricingPlanRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    try {
      await api.post(`/v1/pricing/plans/${archiving.id}/archive`);
      toast.success('Plan archived');
      setArchiving(null);
      await qc.invalidateQueries({ queryKey: ['pricing-plans'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (plans.isPending) return <LoadingSkeleton rows={6} />;
  if (plans.error) return <ErrorState message={errorMessage(plans.error)} onRetry={() => void plans.refetch()} />;
  return (
    <div className="space-y-6">
      {can('pricing.manage') && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus /> New plan</Button></div>}
      {(Object.keys(KIND_LABELS) as PricingPlanRow['kind'][]).map((kind) => {
        const list = plans.data.filter((p) => p.kind === kind);
        return (
          <Card key={kind} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">{KIND_LABELS[kind].title}</CardTitle>
              <CardDescription>{KIND_LABELS[kind].description}</CardDescription>
            </CardHeader>
            <CardContent>
              {list.length === 0 ? (
                <EmptyState icon={Tags} title="No plans" description="Transactions are refused until a default plan exists." className="py-6" />
              ) : (
                <ul className="divide-y rounded-lg border">
                  {list.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                      <div className="space-y-1">
                        <p className="flex items-center gap-2 font-medium">{p.name} {p.is_default && <Badge variant="secondary">Default</Badge>} <StatusBadge status={p.status} /></p>
                        <ul className="text-muted-foreground text-sm">{p.rules.map((r) => <li key={r.id}>{describeRule(r)}</li>)}</ul>
                        <p className="text-muted-foreground text-xs">GST {p.tax_rate}% · fee {p.refund_fee ? 'returned' : 'kept'} on refund · effective {formatDateTime(p.effective_from)}{p.effective_to ? ` – ${formatDateTime(p.effective_to)}` : ''}</p>
                      </div>
                      {can('pricing.manage') && p.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => setArchiving(p)}>Archive</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
      <CreatePlanDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this plan?"
        description={archiving?.is_default ? 'This is a default plan — without a replacement default, new transactions for unassigned merchants will be refused.' : 'Merchants assigned to it fall back to the default plan.'}
        confirmLabel="Archive"
        destructive
        pending={busy}
        onConfirm={() => void archive()}
      />
    </div>
  );
}
