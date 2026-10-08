'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Lock, Play, Unlock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { fmt } from '@/features/ledger/format';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ProviderRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { SettlementConfigEditor } from './settlement-config';

export function SettlementActions() {
  const can = useCan();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!can('settlement.process')) return null;
  async function run() {
    setBusy('run');
    try {
      const r = await api.post<{ result: string; reason?: string }[]>('/v1/settlements/run');
      const created = r.filter((x) => x.result === 'CREATED').length;
      toast.success(`${created} settlement${created === 1 ? '' : 's'} created${r.length - created ? `, ${r.length - created} skipped` : ''}`);
      await qc.invalidateQueries({ queryKey: ['settlements'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function download() {
    setBusy('file');
    try {
      await apiDownload('/v1/settlements/transfer-file', 'pay2all-settlements.csv');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy !== null} onClick={() => void run()}>{busy === 'run' ? <Loader2 className="animate-spin" /> : <Play />} Run due settlements</Button>
      <Button variant="outline" disabled={busy !== null} onClick={() => void download()} title="Contains full account numbers — handle as confidential">{busy === 'file' ? <Loader2 className="animate-spin" /> : <Download />} Bank transfer file</Button>
    </div>
  );
}

export function SchedulesPanel() {
  const [merchantId, setMerchantId] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <MerchantCombobox value={merchantId} onChange={(m) => setMerchantId(m?.id ?? null)} status="APPROVED" className="w-72" />
      {merchantId ? <SettlementConfigEditor merchantId={merchantId} /> : <p className="text-muted-foreground text-sm">Choose a merchant to view or change its settlement schedule.</p>}
    </div>
  );
}

interface HoldRow {
  hold_id: string;
  merchant_id: string;
  merchant_name: string | null;
  reason: string;
  placed_at: string;
  released_at: string | null;
}

export function HoldsPanel() {
  const can = useCan();
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: ['settlement-holds'], queryFn: () => api.get<HoldRow[]>('/v1/settlements/holds') });
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [releasing, setReleasing] = useState<HoldRow | null>(null);
  const [busy, setBusy] = useState(false);
  async function place() {
    setBusy(true);
    try {
      await api.post('/v1/settlements/holds', { merchant_id: merchantId, reason });
      toast.success('Settlements on hold for this merchant');
      setReason('');
      await qc.invalidateQueries({ queryKey: ['settlement-holds'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function release(why?: string) {
    if (!releasing) return;
    setBusy(true);
    try {
      await api.post(`/v1/settlements/holds/${releasing.hold_id}/release`, { reason: why });
      toast.success('Hold released');
      setReleasing(null);
      await qc.invalidateQueries({ queryKey: ['settlement-holds'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      {can('settlement.hold') && (
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-base">Place a hold</CardTitle><CardDescription>Stops new settlements for the merchant until released. Payments keep accruing in unsettled.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <MerchantCombobox value={merchantId} onChange={(m) => setMerchantId(m?.id ?? null)} status="APPROVED" className="w-64" />
            <Input className="min-w-64 flex-1" placeholder="Reason (e.g. chargeback investigation)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button disabled={!merchantId || reason.trim().length < 5 || busy} onClick={() => void place()}><Lock /> Hold settlements</Button>
          </CardContent>
        </Card>
      )}
      <DataTable
        rows={holds.data}
        loading={holds.isFetching}
        error={toTableError(holds.error)}
        rowKey={(h) => h.hold_id}
        empty={{ title: 'No active holds' }}
        columns={[
          { id: 'merchant', header: 'Merchant', cell: (h) => <span className="font-medium">{h.merchant_name ?? h.merchant_id}</span> },
          { id: 'reason', header: 'Reason', cell: (h) => <span className="text-sm">{h.reason}</span> },
          { id: 'since', header: 'Since', cell: (h) => <span className="text-sm whitespace-nowrap">{formatDateTime(h.placed_at)}</span> },
          { id: 'act', header: '', align: 'right', cell: (h) => (can('settlement.hold') ? <Button size="sm" variant="outline" onClick={() => setReleasing(h)}><Unlock /> Release</Button> : null) },
        ]}
      />
      <ConfirmDialog open={Boolean(releasing)} onOpenChange={(o) => !o && setReleasing(null)} title="Release this hold?" description="Settlements resume from the next run, including everything that accrued during the hold." confirmLabel="Release" requireReason pending={busy} onConfirm={(r) => void release(r)} />
    </div>
  );
}

interface RemittanceRow {
  remittance_id: string;
  provider: string;
  reference: string;
  value_date: string;
  amount: string;
  cost: string;
  created_at: string;
}

export function RemittancesPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['remittances'], queryFn: () => api.get<RemittanceRow[]>('/v1/settlements/remittances') });
  const providers = useQuery({ queryKey: ['providers', 'all'], queryFn: () => api.get<ProviderRow[]>('/v1/providers') });
  const [form, setForm] = useState(() => ({ provider_id: '', reference: '', value_date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), amount: '', cost: '0.00' }));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.provider_id && form.reference.length >= 3 && /^\d+(\.\d{1,2})?$/.test(form.amount) && /^\d+(\.\d{1,2})?$/.test(form.cost);
  async function submit() {
    setBusy(true);
    try {
      await api.post('/v1/settlements/remittances', form);
      toast.success('Remittance recorded and posted to the ledger');
      setForm((f) => ({ ...f, reference: '', amount: '', cost: '0.00' }));
      await qc.invalidateQueries({ queryKey: ['remittances'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-base">Record a provider remittance</CardTitle><CardDescription>Money a provider sent to our bank, net of its cost. Posts Dr bank + Dr provider cost / Cr provider clearing.</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5"><Label htmlFor="rm-prov">Provider</Label>
            <Select value={form.provider_id} onValueChange={(v) => set('provider_id', v)}>
              <SelectTrigger id="rm-prov" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{(providers.data ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="rm-ref">Bank reference / UTR</Label><Input id="rm-ref" value={form.reference} onChange={(e) => set('reference', e.target.value.trim())} /></div>
          <div className="space-y-1.5"><Label htmlFor="rm-date">Value date</Label><Input id="rm-date" type="date" value={form.value_date} onChange={(e) => set('value_date', e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rm-amt">Received (₹)</Label><Input id="rm-amt" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rm-cost">Provider cost (₹)</Label><Input id="rm-cost" inputMode="decimal" value={form.cost} onChange={(e) => set('cost', e.target.value)} /></div>
          <div className="sm:col-span-5"><Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Record remittance</Button></div>
        </CardContent>
      </Card>
      <DataTable
        rows={list.data}
        loading={list.isFetching}
        error={toTableError(list.error)}
        rowKey={(r) => r.remittance_id}
        empty={{ title: 'No remittances recorded' }}
        columns={[
          { id: 'date', header: 'Value date', cell: (r) => <span className="text-sm">{r.value_date}</span> },
          { id: 'provider', header: 'Provider', cell: (r) => <span className="font-mono text-xs">{r.provider}</span> },
          { id: 'ref', header: 'Reference', cell: (r) => <span className="font-mono text-xs">{r.reference}</span> },
          { id: 'cost', header: 'Cost', align: 'right', cell: (r) => <span className="tabular text-sm">{fmt(r.cost)}</span> },
          { id: 'amount', header: 'Received', align: 'right', cell: (r) => <span className="tabular font-medium">{fmt(r.amount)}</span> },
        ]}
      />
    </div>
  );
}
