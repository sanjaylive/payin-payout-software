'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2, Pencil, Plus, Route as RouteIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ProviderRoute, ProviderRow, RoutingSimulation } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const METHODS = { PAYIN: ['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK', 'UPI_STATIC_QR'], PAYOUT: ['IMPS', 'NEFT', 'RTGS', 'UPI'] } as const;
const ANY = '__any__';

type Form = { name: string; tier: string; priority: string; provider_id: string; merchant_id: string; method: string; min_amount: string; max_amount: string; is_active: boolean };

function RouteDialog({ service, route, open, onOpenChange }: { service: 'PAYIN' | 'PAYOUT'; route: ProviderRoute | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers', service], queryFn: () => api.get<ProviderRow[]>('/v1/providers', { kind: service }), enabled: open });
  const [f, setF] = useState<Form>(() => ({
    name: route?.name ?? '',
    tier: route?.tier ?? 'PRIMARY',
    priority: String(route?.priority ?? 100),
    provider_id: route?.provider.id ?? '',
    merchant_id: route?.merchant_id ?? ANY,
    method: route?.method ?? ANY,
    min_amount: route?.min_amount ?? '',
    max_amount: route?.max_amount ?? '',
    is_active: route?.is_active ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF({ ...f, [k]: v });

  async function save() {
    setBusy(true);
    const body = {
      name: f.name, service, tier: f.tier, priority: Number(f.priority), provider_id: f.provider_id,
      merchant_id: f.merchant_id === ANY ? null : f.merchant_id, method: f.method === ANY ? null : f.method,
      min_amount: f.min_amount || null, max_amount: f.max_amount || null, risk_categories: route?.risk_categories ?? [], time_window: route?.time_window ?? null, is_active: f.is_active,
    };
    try {
      if (route) await api.put(`/v1/provider-routes/${route.id}`, body);
      else await api.post('/v1/provider-routes', body);
      toast.success('Route saved');
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['routes'] });
    } catch (e) {
      toast.error(e instanceof ApiError && e.details?.length ? e.details.map((d) => `${d.path}: ${d.message}`).join('; ') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{route ? 'Edit route' : `New ${service.toLowerCase()} route`}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => set('name')(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Provider</Label>
            <Select value={f.provider_id} onValueChange={set('provider_id')}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>{providers.data?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} ({p.status.toLowerCase()})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Tier</Label>
            <Select value={f.tier} onValueChange={set('tier')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{['PRIMARY', 'SECONDARY', 'FALLBACK'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Priority (lower first)</Label><Input inputMode="numeric" value={f.priority} onChange={(e) => set('priority')(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>Merchant</Label>
            <MerchantCombobox value={f.merchant_id === ANY ? null : f.merchant_id} onChange={(m) => set('merchant_id')(m?.id ?? ANY)} status="APPROVED,SUSPENDED" anyLabel="Any merchant" />
          </div>
          <div className="space-y-1.5">
            <Label>{service === 'PAYIN' ? 'Method' : 'Mode'}</Label>
            <Select value={f.method} onValueChange={set('method')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ANY}>Any</SelectItem>{METHODS[service].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Min amount (₹)</Label><Input inputMode="decimal" placeholder="No minimum" value={f.min_amount} onChange={(e) => set('min_amount')(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Max amount (₹)</Label><Input inputMode="decimal" placeholder="No maximum" value={f.max_amount} onChange={(e) => set('max_amount')(e.target.value)} /></div>
          <label className="flex items-center justify-between rounded-lg border p-3 text-sm sm:col-span-2">Active <Switch checked={f.is_active} onCheckedChange={set('is_active')} /></label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !f.name || !f.provider_id} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save route</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Simulator({ service }: { service: 'PAYIN' | 'PAYOUT' }) {
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('1000.00');
  const [method, setMethod] = useState<string>(METHODS[service][0]);
  const [result, setResult] = useState<RoutingSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      setResult(await api.post<RoutingSimulation>('/v1/routing/simulate', { service, merchant_id: merchant, amount, method }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Routing simulator</CardTitle>
        <CardDescription>See which providers a transaction would try, in order, and why each rule matched or was skipped.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label>Merchant</Label>
            <MerchantCombobox value={merchant || null} onChange={(m) => setMerchant(m?.id ?? '')} status="APPROVED,SUSPENDED,DRAFT,UNDER_REVIEW" />
          </div>
          <div className="w-36 space-y-1.5"><Label>Amount (₹)</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="w-40 space-y-1.5">
            <Label>{service === 'PAYIN' ? 'Method' : 'Mode'}</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{METHODS[service].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button disabled={!merchant || busy} onClick={() => void run()}>{busy ? <Loader2 className="animate-spin" /> : <RouteIcon />} Simulate</Button>
        </div>
        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Attempt order:</span>
              {result.candidates.length === 0 ? <StatusBadge status="NO PROVIDER AVAILABLE" tone="danger" /> : result.candidates.map((c) => <StatusBadge key={c.provider_code} status={`${c.order}. ${c.provider_code}${c.degraded ? ' (degraded)' : ''}`} tone={c.order === 1 ? 'success' : 'neutral'} />)}
            </div>
            <ul className="divide-y rounded-lg border">
              {result.evaluations.map((e) => (
                <li key={e.route_id} className="flex items-start gap-3 p-3 text-sm">
                  {e.selected ? <CircleCheck className="text-success mt-0.5 size-4 shrink-0" /> : <CircleX className="text-muted-foreground mt-0.5 size-4 shrink-0" />}
                  <div>
                    <p className={cn('font-medium', !e.selected && 'text-muted-foreground')}>{e.route_name} <span className="font-mono text-xs">→ {e.provider_code} · {e.tier}</span></p>
                    <p className="text-muted-foreground text-xs">{e.reasons.join(' · ')}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RoutesManager() {
  const can = useCan();
  const [service, setService] = useState<'PAYIN' | 'PAYOUT'>('PAYOUT');
  const [editing, setEditing] = useState<ProviderRoute | null | 'new'>(null);
  const routes = useQuery({ queryKey: ['routes', service], queryFn: () => api.list<ProviderRoute>('/v1/provider-routes', { service, limit: 100 }) });
  const tierOrder = { PRIMARY: 0, SECONDARY: 1, FALLBACK: 2 };
  const rows = [...(routes.data?.data ?? [])].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.priority - b.priority);
  return (
    <div className="space-y-6">
      <DataTable
        toolbar={
          <>
            <Tabs value={service} onValueChange={(v) => setService(v as 'PAYIN' | 'PAYOUT')}>
              <TabsList><TabsTrigger value="PAYOUT">Payout routes</TabsTrigger><TabsTrigger value="PAYIN">Payin routes</TabsTrigger></TabsList>
            </Tabs>
            {can('routing.manage') && <Button className="ml-auto" onClick={() => setEditing('new')}><Plus /> New route</Button>}
          </>
        }
        rows={routes.data ? rows : undefined}
        loading={routes.isFetching}
        error={toTableError(routes.error)}
        rowKey={(r) => r.id}
        empty={{ title: 'No routes — nothing will be routed for this service' }}
        columns={[
          { id: 'tier', header: 'Tier', cell: (r) => <div className="space-y-0.5"><StatusBadge status={r.tier} tone={r.tier === 'PRIMARY' ? 'primary' : 'neutral'} /><p className="text-muted-foreground text-xs">priority {r.priority}</p></div> },
          { id: 'name', header: 'Rule', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-muted-foreground text-xs">{[r.merchant_id ? 'merchant-specific' : r.reseller_id ? 'reseller-specific' : 'all merchants', r.method ?? 'any method', r.min_amount || r.max_amount ? `₹${r.min_amount ?? '0'}–${r.max_amount ? `₹${r.max_amount}` : '∞'}` : 'any amount'].join(' · ')}</p></div> },
          { id: 'provider', header: 'Provider', cell: (r) => <div className="flex items-center gap-2"><span className="font-mono text-xs">{r.provider.code}</span><StatusBadge status={r.provider.status} /></div> },
          { id: 'active', header: 'Active', cell: (r) => (r.is_active ? 'Yes' : 'No') },
          { id: 'a', header: '', align: 'right', cell: (r) => (can('routing.manage') ? <Button variant="ghost" size="icon" aria-label="Edit route" onClick={() => setEditing(r)}><Pencil /></Button> : null) },
        ]}
      />
      <Simulator key={service} service={service} />
      {editing && <RouteDialog key={editing === 'new' ? 'new' : editing.id} service={service} route={editing === 'new' ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
    </div>
  );
}
