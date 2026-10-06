'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, Gauge, KeyRound, Loader2, Plug, Timer, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ProviderRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { healthFor, ms, pct, ProviderStatus } from './providers-list';

function CredentialsDialog({ p, open, onOpenChange }: { p: ProviderRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [env, setEnv] = useState<'TEST' | 'LIVE'>(p.environment);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      await api.put(`/v1/providers/${p.id}/credentials`, { environment: env, values: filled });
      toast.success('Credentials saved (encrypted)');
      setValues({});
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['provider', p.id] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setValues({}); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set credentials</DialogTitle>
          <DialogDescription>Values are encrypted immediately and can never be viewed again — only replaced. Saving replaces the whole set for this environment.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <Select value={env} onValueChange={(v) => setEnv(v as 'TEST' | 'LIVE')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="TEST">TEST</SelectItem><SelectItem value="LIVE">LIVE</SelectItem></SelectContent>
            </Select>
          </div>
          {p.required_credentials.map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`cred-${k}`} className="font-mono text-xs">{k}</Label>
              <Input id={`cred-${k}`} type="password" autoComplete="off" value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !Object.values(values).some((v) => v.trim())} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save credentials</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProviderDetail({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const provider = useQuery({ queryKey: ['provider', id], queryFn: () => api.get<ProviderRow>(`/v1/providers/${id}`), refetchInterval: 15_000 });
  const [credsOpen, setCredsOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<'ACTIVE' | 'MAINTENANCE' | 'DISABLED' | null>(null);
  const [busy, setBusy] = useState(false);
  if (provider.isPending) return <LoadingSkeleton rows={6} />;
  if (provider.isError) return <ErrorState message={errorMessage(provider.error)} />;
  const p = provider.data;
  const kinds = p.kind === 'BOTH' ? (['PAYIN', 'PAYOUT'] as const) : ([p.kind] as const);

  async function changeStatus(reason?: string) {
    setBusy(true);
    try {
      await api.patch(`/v1/providers/${id}/status`, { status: statusTarget, reason });
      toast.success('Status updated');
      setStatusTarget(null);
      await qc.invalidateQueries({ queryKey: ['provider', id] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; latency_ms: number; error_kind?: string; message?: string }>(`/v1/providers/${id}/test`);
      if (r.ok) toast.success(`Connected in ${r.latency_ms} ms`);
      else toast.error(`${r.error_kind}: ${r.message}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href={p.kind === 'PAYIN' ? '/admin/providers/payin' : '/admin/providers/payout'} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" /> Providers</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="text-muted-foreground mt-1 font-mono text-xs">{p.code} · {p.adapter_label} · {p.environment}</p>
          {p.status_reason && <p className="text-muted-foreground mt-2 text-sm">{p.status_reason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProviderStatus p={p} />
          {can('provider.manage') && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void test()}><Plug /> Test connection</Button>
              <Button variant="outline" onClick={() => setCredsOpen(true)}><KeyRound /> Credentials</Button>
              {p.status !== 'MAINTENANCE' && <Button variant="outline" onClick={() => setStatusTarget('MAINTENANCE')}>Maintenance</Button>}
              {p.status !== 'DISABLED' && <Button variant="outline" onClick={() => setStatusTarget('DISABLED')}>Disable</Button>}
              {(p.status === 'MAINTENANCE' || p.status === 'DISABLED') && <Button onClick={() => setStatusTarget('ACTIVE')}>Enable</Button>}
            </>
          )}
        </div>
      </div>

      {kinds.map((k) => {
        const h = healthFor(p, k);
        return (
          <section key={k}>
            <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">{k} health · last {h?.window_minutes ?? 15} minutes</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Success rate" value={pct(h?.success_rate)} icon={Activity} hint={`${h?.requests ?? 0} requests`} />
              <StatCard label="Failure / timeout" value={`${pct(h?.failure_rate)} / ${pct(h?.timeout_rate)}`} icon={TriangleAlert} />
              <StatCard label="Latency avg / p95" value={`${ms(h?.avg_latency_ms)}`} icon={Timer} hint={`p95 ${ms(h?.p95_latency_ms)} · p99 ${ms(h?.p99_latency_ms)}`} />
              <StatCard label="Last success" value={<span className="text-base">{h?.last_success_at ? formatDateTime(h.last_success_at) : '—'}</span>} icon={Gauge} hint={h?.last_failure_at ? `Last failure ${formatDateTime(h.last_failure_at)}` : undefined} />
            </div>
          </section>
        );
      })}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-base">Credentials</CardTitle><CardDescription>Encrypted at rest; shown as fingerprints only.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {p.credentials.length === 0 && <p className="text-muted-foreground text-sm">No credentials set. Required: <span className="font-mono">{p.required_credentials.join(', ')}</span></p>}
            {p.credentials.map((c) => (
              <div key={c.environment} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between"><StatusBadge status={c.environment} tone="neutral" /><span className="text-muted-foreground text-xs">Rotated {formatDateTime(c.rotated_at)}</span></div>
                <div className="mt-2 flex flex-wrap gap-3 font-mono text-xs">{Object.entries(c.fingerprints).map(([k, v]) => <span key={k}>{k}: {v}</span>)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-base">Capabilities and configuration</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {p.capabilities.payin_methods && <p><span className="text-muted-foreground">Payin methods:</span> {p.capabilities.payin_methods.join(', ')}</p>}
            {p.capabilities.payout_modes && <p><span className="text-muted-foreground">Payout modes:</span> {p.capabilities.payout_modes.join(', ')}</p>}
            <pre className="bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs">{JSON.stringify({ config: p.config, costs: p.costs }, null, 2)}</pre>
          </CardContent>
        </Card>
      </div>

      {p.snapshots && p.snapshots.length > 0 && (
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-base">Health history</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Window end</TableHead><TableHead>Service</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Success</TableHead><TableHead className="text-right">p95</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {p.snapshots.slice(0, 12).map((s) => (
                  <TableRow key={`${s.service}-${s.window_end}`}>
                    <TableCell>{formatDateTime(s.window_end)}</TableCell>
                    <TableCell>{s.service}</TableCell>
                    <TableCell className="tabular text-right">{s.requests}</TableCell>
                    <TableCell className="tabular text-right">{pct(s.success_rate)}</TableCell>
                    <TableCell className="tabular text-right">{ms(s.p95_latency_ms)}</TableCell>
                    <TableCell><StatusBadge status={s.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CredentialsDialog p={p} open={credsOpen} onOpenChange={setCredsOpen} />
      <ConfirmDialog
        open={Boolean(statusTarget)}
        onOpenChange={(o) => !o && setStatusTarget(null)}
        title={statusTarget === 'ACTIVE' ? 'Enable provider?' : statusTarget === 'MAINTENANCE' ? 'Put provider in maintenance?' : 'Disable provider?'}
        description={statusTarget === 'ACTIVE' ? 'Traffic resumes and the health breaker manages its status automatically.' : 'No new transactions will be routed here. In-flight transactions continue to be tracked.'}
        destructive={statusTarget !== 'ACTIVE'}
        requireReason
        pending={busy}
        onConfirm={(reason) => void changeStatus(reason)}
      />
    </div>
  );
}
