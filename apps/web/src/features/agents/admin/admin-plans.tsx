'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { AMOUNT_RE, type AgentPlan, toAmount } from '../api';

const KEY = ['admin', 'agent-plans'];

/** Admin → Agents → Plans: names, prices, limits and features. Plan codes are fixed. */
export function AdminAgentPlans() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<AgentPlan[]>('/v1/admin/agent-plans') });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {q.data.map((p) => (
        <PlanEditor key={`${p.code}:${JSON.stringify(p)}`} plan={p} />
      ))}
    </div>
  );
}

function PlanEditor({ plan }: { plan: AgentPlan }) {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('agent.admin.manage');
  const free = plan.code === 'FREE';
  const [v, setV] = useState({
    name: plan.name,
    description: plan.description ?? '',
    price_monthly: plan.price_monthly,
    price_yearly: plan.price_yearly,
    unlimited: plan.monthly_txn_limit === null,
    monthly_txn_limit: String(plan.monthly_txn_limit ?? 1000),
    staff_limit: String(plan.staff_limit),
    drive_backup: plan.drive_backup,
    branded_receipts: plan.branded_receipts,
    messaging: plan.messaging,
    active: plan.active,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));

  const limitOk = v.unlimited || (/^\d+$/.test(v.monthly_txn_limit) && Number(v.monthly_txn_limit) >= 1);
  const staffOk = /^\d+$/.test(v.staff_limit) && Number(v.staff_limit) >= 1 && Number(v.staff_limit) <= 500;
  const pricesOk = free || (AMOUNT_RE.test(v.price_monthly.trim()) && AMOUNT_RE.test(v.price_yearly.trim()));
  const valid = v.name.trim().length >= 2 && limitOk && staffOk && pricesOk;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch<AgentPlan>(`/v1/admin/agent-plans/${plan.code}`, {
        name: v.name.trim(),
        description: v.description.trim(),
        ...(free ? {} : { price_monthly: toAmount(v.price_monthly), price_yearly: toAmount(v.price_yearly), active: v.active }),
        monthly_txn_limit: v.unlimited ? null : Number(v.monthly_txn_limit),
        staff_limit: Number(v.staff_limit),
        drive_backup: v.drive_backup,
        branded_receipts: v.branded_receipts,
        messaging: v.messaging,
      });
      toast.success(`${v.name.trim()} plan saved`);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const sw = (k: 'drive_backup' | 'branded_receipts' | 'messaging' | 'active', label: string, disabled = false) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <Label htmlFor={`${plan.code}-${k}`} className="font-normal">
        {label}
      </Label>
      <Switch id={`${plan.code}-${k}`} checked={v[k]} disabled={!manage || disabled} onCheckedChange={(c) => set(k, c)} />
    </div>
  );

  return (
    <section className="bg-card space-y-4 rounded-xl border p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{plan.code}</h2>
        {!plan.active && <span className="text-muted-foreground text-xs">Switched off</span>}
      </div>
      <FormError error={error} />
      <fieldset disabled={!manage} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${plan.code}-name`}>Name</Label>
          <Input id={`${plan.code}-name`} maxLength={40} value={v.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${plan.code}-desc`}>Description</Label>
          <Textarea id={`${plan.code}-desc`} rows={2} maxLength={255} value={v.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${plan.code}-pm`}>Monthly price (₹)</Label>
            <Input id={`${plan.code}-pm`} inputMode="decimal" disabled={free} value={v.price_monthly} onChange={(e) => set('price_monthly', e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${plan.code}-py`}>Yearly price (₹)</Label>
            <Input id={`${plan.code}-py`} inputMode="decimal" disabled={free} value={v.price_yearly} onChange={(e) => set('price_yearly', e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${plan.code}-limit`}>Entries a month</Label>
            <Input
              id={`${plan.code}-limit`}
              inputMode="numeric"
              disabled={v.unlimited}
              value={v.unlimited ? '' : v.monthly_txn_limit}
              placeholder={v.unlimited ? 'Unlimited' : undefined}
              onChange={(e) => set('monthly_txn_limit', e.target.value.replace(/\D/g, ''))}
              aria-invalid={!limitOk}
            />
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={v.unlimited} disabled={!manage} onCheckedChange={(c) => set('unlimited', c)} aria-label="Unlimited entries" /> Unlimited
            </label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${plan.code}-staff`}>Logins</Label>
            <Input id={`${plan.code}-staff`} inputMode="numeric" value={v.staff_limit} onChange={(e) => set('staff_limit', e.target.value.replace(/\D/g, ''))} aria-invalid={!staffOk} />
            <p className="text-muted-foreground text-xs">Owner included, 1–500</p>
          </div>
        </div>
        <div className="divide-y rounded-lg border px-3">
          {sw('drive_backup', 'Google Drive backup')}
          {sw('branded_receipts', 'Branded receipts')}
          {sw('messaging', 'SMS / WhatsApp receipts')}
          {sw('active', free ? 'Active (Free is always on)' : 'Offered to agents', free)}
        </div>
      </fieldset>
      {manage && (
        <Button className="w-full" disabled={busy || !valid} onClick={() => void save()}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />} Save {plan.code.toLowerCase()}
        </Button>
      )}
    </section>
  );
}
