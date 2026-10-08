'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';

type Service = 'PAYIN' | 'PAYOUT';
interface Policy {
  service: Service;
  strategy: 'PRIORITY' | 'SCORE';
  window_minutes: number;
  min_samples: number;
  explore_percent: number;
  version: number;
  updated_at: string | null;
}
interface Scores {
  policy: Policy;
  method: string;
  prior: number;
  providers: { provider_id: string; code: string; name: string; status: string; completed: number; success: number; conversion: number | null; smoothed: number; api_success_rate: number | null; score: number }[];
}

/** Two decimals near the top so 99.997% never reads as a perfect 100.0%. */
const pct = (r: number | null) => (r === null ? '—' : r === 1 ? '100%' : `${(Math.floor(r * (r >= 0.99 ? 10_000 : 1_000)) / (r >= 0.99 ? 100 : 10)).toFixed(r >= 0.99 ? 2 : 1)}%`);

/** Smart routing (docs/ROUTING.md): strategy per service and the live scoreboard behind it. */
export function RoutingStrategy({ service, methods }: { service: Service; methods: readonly string[] }) {
  const policies = useQuery({ queryKey: ['routing-policies'], queryFn: () => api.get<Policy[]>('/v1/routing/policies') });
  const policy = policies.data?.find((p) => p.service === service);
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4" /> Strategy
        </CardTitle>
        <CardDescription>
          <strong>Priority</strong> follows the tiers and priorities below. <strong>Success-rate score</strong> ranks PRIMARY and SECONDARY routes together by recent conversion × API health; merchant-specific rules still come first and FALLBACK stays the last resort.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!policy ? <Skeleton className="h-20" /> : <PolicyForm key={`${service}-${policy.version}`} policy={policy} />}
        <Scoreboard service={service} methods={methods} />
      </CardContent>
    </Card>
  );
}

function PolicyForm({ policy }: { policy: Policy }) {
  const can = useCan();
  const qc = useQueryClient();
  const [f, setF] = useState({ strategy: policy.strategy, window_minutes: String(policy.window_minutes), min_samples: String(policy.min_samples), explore_percent: String(policy.explore_percent), reason: '' });
  const [busy, setBusy] = useState(false);
  const editable = can('routing.manage');
  const changed = f.strategy !== policy.strategy || f.window_minutes !== String(policy.window_minutes) || f.min_samples !== String(policy.min_samples) || f.explore_percent !== String(policy.explore_percent);
  async function save() {
    setBusy(true);
    try {
      await api.put(`/v1/routing/policies/${policy.service}`, { strategy: f.strategy, window_minutes: Number(f.window_minutes), min_samples: Number(f.min_samples), explore_percent: Number(f.explore_percent), reason: f.reason });
      toast.success('Routing strategy saved');
      await qc.invalidateQueries({ queryKey: ['routing-policies'] });
      await qc.invalidateQueries({ queryKey: ['routing-scores'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const num = (k: 'window_minutes' | 'min_samples' | 'explore_percent', label: string, hint: string, min: number, max: number) => (
    <div className="w-40 space-y-1.5">
      <Label htmlFor={`rp-${k}`}>{label}</Label>
      <Input id={`rp-${k}`} type="number" min={min} max={max} value={f[k]} disabled={!editable || f.strategy !== 'SCORE'} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
      <p className="text-muted-foreground text-[11px]">{hint}</p>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="w-56 space-y-1.5">
          <Label>Strategy</Label>
          <Select value={f.strategy} onValueChange={(v) => setF((x) => ({ ...x, strategy: v as Policy['strategy'] }))} disabled={!editable}>
            <SelectTrigger className="w-full" aria-label="Strategy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PRIORITY">Priority (rules order)</SelectItem>
              <SelectItem value="SCORE">Success-rate score</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {num('window_minutes', 'Window (minutes)', 'Look-back, 5–1440', 5, 1440)}
        {num('min_samples', 'Confidence', 'Transactions before a gateway’s own rate dominates', 1, 1000)}
        {num('explore_percent', 'Exploration %', 'Traffic to the runner-up, 0–20', 0, 20)}
      </div>
      {editable && changed && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="rp-reason">Reason (audited)</Label>
            <Input id="rp-reason" value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} placeholder="Why this change" />
          </div>
          <Button disabled={busy || f.reason.trim().length < 5} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Save strategy
          </Button>
        </div>
      )}
    </div>
  );
}

function Scoreboard({ service, methods }: { service: Service; methods: readonly string[] }) {
  const [method, setMethod] = useState<string>(methods[0]!);
  const q = useQuery({ queryKey: ['routing-scores', service, method], queryFn: () => api.get<Scores>('/v1/routing/scores', { service, method }), refetchInterval: 30_000 });
  const rows = q.data?.providers.filter((p) => p.status !== 'DISABLED') ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Scoreboard <span className="text-muted-foreground font-normal">· last {q.data?.policy.window_minutes ?? '…'} minutes · pooled rate {pct(q.data?.prior ?? null)}</span>
        </p>
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger className="w-44" aria-label="Method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {methods.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {q.isError ? (
        <p className="text-destructive text-sm">{errorMessage(q.error)}</p>
      ) : !q.data ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Gateway</th>
                <th className="px-3 py-2 text-right font-medium">Completed</th>
                <th className="px-3 py-2 text-right font-medium">Conversion</th>
                <th className="px-3 py-2 text-right font-medium">Smoothed</th>
                <th className="px-3 py-2 text-right font-medium">API health</th>
                <th className="px-3 py-2 text-left font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.provider_id} className="border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.name}</span> <span className="text-muted-foreground font-mono text-xs">{r.code}</span> {r.status !== 'ACTIVE' && <StatusBadge status={r.status} />}
                  </td>
                  <td className="tabular px-3 py-2 text-right">{r.completed.toLocaleString('en-IN')}</td>
                  <td className="tabular px-3 py-2 text-right">{pct(r.conversion)}</td>
                  <td className="tabular px-3 py-2 text-right">{pct(r.smoothed)}</td>
                  <td className="tabular px-3 py-2 text-right">{pct(r.api_success_rate)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="bg-muted h-1.5 w-24 overflow-hidden rounded-full" role="presentation">
                        <div className={i === 0 ? 'bg-primary h-full rounded-full' : 'bg-primary/50 h-full rounded-full'} style={{ width: `${r.score * 100}%` }} />
                      </div>
                      <span className="tabular font-medium">{pct(r.score)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted-foreground text-xs">Gateways with few completed transactions are pulled towards the pooled rate. Only gateways that a matching route allows can be chosen.</p>
    </div>
  );
}
