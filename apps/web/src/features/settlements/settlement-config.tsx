'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { SettlementConfigView } from '@/lib/api/types';
import { DESTINATION_LABEL } from './settlements';

const CYCLE_TEXT = (c: SettlementConfigView) => (c.cycle === 'T0' ? 'same day' : c.cycle === 'CUSTOM' ? `${c.custom_days} days after capture` : `${c.cycle.slice(1)} day${c.cycle === 'T1' ? '' : 's'} after capture`);

export function useSettlementConfig(merchantId: string | undefined) {
  return useQuery({ queryKey: ['settlement-config', merchantId], queryFn: () => api.get<SettlementConfigView>(`/v1/settlements/config/${merchantId}`), enabled: Boolean(merchantId) });
}

/** Read-only schedule card (merchants). */
export function SettlementScheduleCard({ merchantId }: { merchantId: string }) {
  const { data: c, isPending } = useSettlementConfig(merchantId);
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Your settlement schedule</CardTitle>
        <CardDescription>Set by Pay2All during onboarding. Contact support to change it.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {isPending || !c ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <p>
            <span className="font-medium">{c.cycle}</span> — payments captured before <span className="font-medium">{c.cutoff_time} IST</span> are settled {CYCLE_TEXT(c)} to your <span className="font-medium">{DESTINATION_LABEL[c.destination].toLowerCase()}</span>. Amounts below {fmt(c.min_amount)} carry forward.{!c.auto_settle && ' Automatic settlement is currently paused.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Editor (platform finance). */
export function SettlementConfigEditor({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const { data: c, isPending } = useSettlementConfig(merchantId);
  if (isPending || !c) return <Skeleton className="h-48 w-full" />;
  return <Editor key={merchantId} merchantId={merchantId} initial={c} onSaved={() => void qc.invalidateQueries({ queryKey: ['settlement-config', merchantId] })} />;
}

function Editor({ merchantId, initial, onSaved }: { merchantId: string; initial: SettlementConfigView; onSaved: () => void }) {
  const [v, setV] = useState({ ...initial, reason: '' });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  async function save() {
    setBusy(true);
    try {
      await api.put(`/v1/settlements/config/${merchantId}`, { cycle: v.cycle, custom_days: v.cycle === 'CUSTOM' ? (v.custom_days ?? 3) : null, cutoff_time: v.cutoff_time, min_amount: v.min_amount, destination: v.destination, auto_settle: v.auto_settle, reason: v.reason });
      toast.success('Settlement schedule saved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Settlement schedule</CardTitle>
        <CardDescription>{initial.is_default ? 'Using defaults from onboarding — saving creates an explicit schedule.' : 'Changes apply from the next run and are audited.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="cfg-cycle">Cycle</Label>
            <Select value={v.cycle} onValueChange={(x) => set('cycle', x as SettlementConfigView['cycle'])}>
              <SelectTrigger id="cfg-cycle" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{['T0', 'T1', 'T2', 'CUSTOM'].map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {v.cycle === 'CUSTOM' && <div className="space-y-1.5"><Label htmlFor="cfg-days">Days after capture</Label><Input id="cfg-days" type="number" min={3} max={7} value={v.custom_days ?? 3} onChange={(e) => set('custom_days', Number(e.target.value))} /></div>}
          <div className="space-y-1.5"><Label htmlFor="cfg-cutoff">Cutoff (IST)</Label><Input id="cfg-cutoff" value={v.cutoff_time} onChange={(e) => set('cutoff_time', e.target.value)} placeholder="18:00" /></div>
          <div className="space-y-1.5"><Label htmlFor="cfg-min">Minimum (₹)</Label><Input id="cfg-min" inputMode="decimal" value={v.min_amount} onChange={(e) => set('min_amount', e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-dest">Destination</Label>
            <Select value={v.destination} onValueChange={(x) => set('destination', x as SettlementConfigView['destination'])}>
              <SelectTrigger id="cfg-dest" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="BANK">Bank account (verified)</SelectItem><SelectItem value="WALLET">Payout wallet</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm"><Switch checked={v.auto_settle} onCheckedChange={(x) => set('auto_settle', x)} /> Settle automatically after each cutoff</label>
        <div className="space-y-1.5"><Label htmlFor="cfg-reason">Reason for change</Label><Input id="cfg-reason" value={v.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Merchant requested T2 after risk review" /></div>
        <Button disabled={busy || v.reason.trim().length < 5} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save schedule</Button>
      </CardContent>
    </Card>
  );
}
