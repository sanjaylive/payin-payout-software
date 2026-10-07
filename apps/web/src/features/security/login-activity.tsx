'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { StatusBadge, type StatusTone } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, Download, Globe2, KeyRound, Loader2, Mail, MapPin, Monitor, ShieldAlert, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { LoginEventRow, LoginOutcome, LoginSummary } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

const OUTCOME: Record<LoginOutcome, { label: string; tone: StatusTone }> = {
  SUCCESS: { label: 'Signed in', tone: 'success' },
  MFA_REQUIRED: { label: 'Password OK — 2FA asked', tone: 'info' },
  MFA_FAILED: { label: 'Wrong 2FA code', tone: 'danger' },
  BAD_PASSWORD: { label: 'Wrong password', tone: 'danger' },
  LOCKED: { label: 'Account locked', tone: 'danger' },
  DISABLED: { label: 'Account disabled', tone: 'danger' },
  NOT_ACTIVATED: { label: 'Not activated', tone: 'warning' },
  NO_ACTIVE_ORGANIZATION: { label: 'No active organization', tone: 'warning' },
  UNKNOWN_USER: { label: 'Unknown user', tone: 'neutral' },
};

/** IST calendar day, offset by `days`. */
const istDay = (days = 0) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);

function DeviceIcon({ type }: { type: LoginEventRow['device_type'] }) {
  const Icon = type === 'mobile' ? Smartphone : type === 'tablet' ? Tablet : type === 'bot' ? Bot : Monitor;
  return <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />;
}

function LocationCell({ e }: { e: LoginEventRow }) {
  if (!e.location) return <span className="text-muted-foreground text-xs">Not shared</span>;
  const { latitude, longitude, accuracy_m } = e.location;
  return (
    <a
      className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
      href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=14/${latitude}/${longitude}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in OpenStreetMap"
    >
      <MapPin className="size-3.5" />
      <span className="tabular font-mono">{latitude.toFixed(4)}, {longitude.toFixed(4)}</span>
      {accuracy_m !== null && <span className="text-muted-foreground">±{accuracy_m >= 1000 ? `${(accuracy_m / 1000).toFixed(1)} km` : `${accuracy_m} m`}</span>}
    </a>
  );
}

/**
 * Sign-in history: who signed in (or tried to), when, from which IP and device, and — when they
 * allowed it — where. `organizationId` narrows to one organization (platform / reseller views);
 * without it, the signed-in account's own organization.
 */
export function LoginActivity({ organizationId }: { organizationId?: string }) {
  const can = useCan();
  const pager = useCursorPagination();
  const [result, setResult] = useState<'all' | 'success' | 'failure'>('all');
  const [from, setFrom] = useState(istDay(-29));
  const [to, setTo] = useState(istDay());
  const [busy, setBusy] = useState<'download' | 'email' | null>(null);
  const filters = { organization_id: organizationId, from, to, ...(result !== 'all' ? { result } : {}) };
  const events = useQuery({ queryKey: ['login-events', filters, pager.cursor], queryFn: () => api.list<LoginEventRow>('/v1/login-events', { ...filters, limit: 25, cursor: pager.cursor }), placeholderData: keepPreviousData });
  const summary = useQuery({ queryKey: ['login-summary', filters], queryFn: () => api.get<LoginSummary>('/v1/login-events/summary', filters) });
  const rangeOk = from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 < 92;
  const canExport = can('report.export') && rangeOk;
  const s = summary.data;

  async function download() {
    setBusy('download');
    try {
      const q = new URLSearchParams({ from, to, ...(organizationId ? { organization_id: organizationId } : {}) });
      await apiDownload(`/v1/login-events/export.csv?${q.toString()}`, `pay2all-logins-${from}-to-${to}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function email() {
    setBusy('email');
    try {
      await api.post('/v1/login-events/export-email', { from, to, ...(organizationId ? { organization_id: organizationId } : {}) });
      toast.success('Export started — we’ll email you a download link when it’s ready');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sign-in attempts" value={s ? s.attempts.toLocaleString('en-IN') : '—'} loading={summary.isPending} icon={KeyRound} hint={`${from} → ${to}`} />
        <StatCard label="Failed attempts" value={s ? s.failures.toLocaleString('en-IN') : '—'} loading={summary.isPending} icon={ShieldAlert} hint={s && s.attempts ? `${Math.round((s.failures / s.attempts) * 100)}% of attempts` : undefined} />
        <StatCard label="Distinct IP addresses" value={s ? s.distinct_ips.toLocaleString('en-IN') : '—'} loading={summary.isPending} icon={Globe2} />
        <StatCard label="Last successful sign-in" value={s?.last_success_at ? formatRelative(s.last_success_at) : '—'} loading={summary.isPending} icon={Monitor} hint={s?.last_success_at ? formatDateTime(s.last_success_at) : undefined} />
      </div>
      <DataTable
        rows={events.data?.data}
        loading={events.isFetching}
        error={toTableError(events.error)}
        rowKey={(e) => e.event_id}
        empty={{ title: 'No sign-ins in this period' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(events.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(events.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <div className="flex w-full flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Result</Label>
              <Select value={result} onValueChange={(v) => { setResult(v as typeof result); pager.reset(); }}>
                <SelectTrigger className="w-40" aria-label="Result"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">All attempts</SelectItem><SelectItem value="success">Successful</SelectItem><SelectItem value="failure">Failed</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label htmlFor="la-from" className="text-xs">From</Label><Input id="la-from" type="date" className="w-40" value={from} max={to} onChange={(e) => { setFrom(e.target.value); pager.reset(); }} /></div>
            <div className="space-y-1"><Label htmlFor="la-to" className="text-xs">To</Label><Input id="la-to" type="date" className="w-40" value={to} min={from} max={istDay()} onChange={(e) => { setTo(e.target.value); pager.reset(); }} /></div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" disabled={!canExport || busy !== null} onClick={() => void download()}>{busy === 'download' ? <Loader2 className="animate-spin" /> : <Download />} Download CSV</Button>
              <Button variant="outline" disabled={!canExport || busy !== null} onClick={() => void email()} title="Generated in the background; you get an email with a sign-in-protected download link">{busy === 'email' ? <Loader2 className="animate-spin" /> : <Mail />} Email me</Button>
            </div>
          </div>
        }
        columns={[
          { id: 'time', header: 'When', cell: (e) => <div className="space-y-0.5 whitespace-nowrap"><p className="text-sm">{formatDateTime(e.created_at)}</p><p className="text-muted-foreground text-xs">{formatRelative(e.created_at)}</p></div> },
          { id: 'user', header: 'User', cell: (e) => <div className="space-y-0.5"><p className="text-sm font-medium">{e.user_name ?? '—'}</p><p className="text-muted-foreground font-mono text-xs">{e.identifier}</p></div> },
          { id: 'result', header: 'Result', cell: (e) => <div className="space-y-0.5"><StatusBadge status={OUTCOME[e.outcome].label.toUpperCase()} tone={OUTCOME[e.outcome].tone} />{e.mfa_used && e.success && <p className="text-muted-foreground text-[11px]">with 2FA</p>}</div> },
          { id: 'device', header: 'Device', cell: (e) => <div className="flex items-center gap-2"><DeviceIcon type={e.device_type} /><div className="text-sm"><p>{e.browser ?? 'Unknown browser'}</p><p className="text-muted-foreground text-xs">{e.os ?? '—'}</p></div></div> },
          { id: 'ip', header: 'IP address', cell: (e) => <span className="font-mono text-xs">{e.ip_address ?? '—'}</span> },
          { id: 'loc', header: 'Location', cell: (e) => <LocationCell e={e} /> },
        ]}
      />
      {!rangeOk && <p className="text-destructive text-xs">Choose a range of at most 92 days to export.</p>}
    </div>
  );
}
