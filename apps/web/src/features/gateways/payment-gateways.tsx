'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Eye, EyeOff, Info, KeyRound, Loader2, PlugZap, ShieldCheck, Webhook, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { GatewayRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const KEY = ['gateways'];
const METHOD_LABEL: Record<string, string> = { UPI: 'UPI', CARD: 'Cards', NETBANKING: 'Netbanking', WALLET: 'Wallets', EMI: 'EMI', PAY_LATER: 'Pay later' };

function Monogram({ g, size = 'md' }: { g: GatewayRow; size?: 'md' | 'lg' }) {
  const initials = g.name.replace(/\(.*\)/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-xl font-bold text-white shadow-sm', size === 'lg' ? 'size-12 text-base' : 'size-10 text-sm')} style={{ backgroundColor: g.color }} aria-hidden>
      {initials}
    </span>
  );
}

function stateOf(g: GatewayRow): { label: string; cls: string } {
  const c = g.connection;
  if (!c) return { label: 'Not connected', cls: 'bg-muted text-muted-foreground' };
  if (c.enabled) return { label: c.environment === 'LIVE' ? 'Live' : 'Enabled · Test', cls: c.environment === 'LIVE' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300' };
  if (c.last_test && !c.last_test.ok) return { label: 'Test failed', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' };
  return { label: 'Connected · off', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
}

/** Settings → Payment Gateways: super admins connect gateways by entering credentials. */
export function PaymentGateways() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<GatewayRow[]>('/v1/gateways') });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  const selected = rows.find((g) => g.key === open) ?? null;
  const live = rows.filter((g) => g.connection?.enabled).length;

  return (
    <div className="space-y-5">
      <div className="bg-card flex flex-wrap items-center gap-4 rounded-xl border p-4">
        <span className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
          <PlugZap className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{live ? `${live} gateway${live === 1 ? '' : 's'} enabled for checkout` : 'No gateway enabled yet'}</p>
          <p className="text-muted-foreground text-sm">Enter a gateway’s credentials, test the connection, then enable it. Checkout offers cards, netbanking and wallets through enabled gateways; UPI QR keeps working through your UPI providers.</p>
        </div>
      </div>

      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((g) => {
            const st = stateOf(g);
            return (
              <button key={g.key} type="button" onClick={() => setOpen(g.key)} className="group bg-card hover:border-foreground/20 flex flex-col gap-3 rounded-xl border p-4 text-left transition-all hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Monogram g={g} />
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{g.name}</p>
                      <p className="text-muted-foreground line-clamp-1 text-xs">{g.tagline}</p>
                    </div>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', st.cls)}>{st.label}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {g.methods.map((m) => (
                    <span key={m} className="bg-muted rounded px-1.5 py-0.5 text-[11px] font-medium">
                      {METHOD_LABEL[m] ?? m}
                    </span>
                  ))}
                </div>
                <div className="text-muted-foreground mt-auto flex items-center justify-between border-t pt-3 text-xs">
                  <span>{g.connection?.last_test ? `${g.connection.last_test.ok ? 'Tested' : 'Test failed'} ${formatRelative(g.connection.last_test.at)}` : g.connection ? 'Not tested' : 'Credentials not entered'}</span>
                  <span className="text-primary font-medium group-hover:underline">{g.connection ? 'Manage' : 'Connect'} →</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">{selected && <GatewayPanel key={`${selected.key}:${selected.connection?.environment ?? ''}`} g={selected} />}</SheetContent>
      </Sheet>
    </div>
  );
}

function GatewayPanel({ g }: { g: GatewayRow }) {
  const qc = useQueryClient();
  const can = useCan();
  const canEdit = can('system.settings.manage');
  const c = g.connection;
  const [env, setEnv] = useState<'TEST' | 'LIVE'>(c?.environment ?? 'TEST');
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [priority, setPriority] = useState(String(c?.priority ?? 10));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'toggle' | null>(null);
  const saved = c?.credentials[env]?.fingerprints ?? {};
  const envDiffers = !!c && c.environment !== env;
  const dirty = Object.values(values).some((v) => v.trim()) || envDiffers || (c && String(c.priority ?? 10) !== priority) || !c;
  const missing = g.credential_fields.filter((f) => !f.optional && !values[f.key]?.trim() && !saved[f.key]);

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  async function run<T>(kind: 'save' | 'test' | 'toggle', fn: () => Promise<T>, ok: (r: T) => void) {
    setBusy(kind);
    try {
      const r = await fn();
      ok(r);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(
      'save',
      () => api.put<GatewayRow>(`/v1/gateways/${g.key}`, { environment: env, credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())), priority: Number(priority) || 10, reason: reason.trim() }),
      () => {
        toast.success(`${g.name} saved — run a connection test next`);
        setValues({});
        setReason('');
      },
    );
  const test = () =>
    run(
      'test',
      () => api.post<{ ok: boolean; latency_ms: number; message?: string }>(`/v1/gateways/${g.key}/test`),
      (r) => (r.ok ? toast.success(`Connected to ${g.name} in ${r.latency_ms} ms`) : toast.error(r.message ?? 'Connection test failed')),
    );
  const toggle = (enabled: boolean) =>
    run(
      'toggle',
      () => api.post(`/v1/gateways/${g.key}/enabled`, { enabled, reason: reason.trim() || (enabled ? 'Enabled after a passing connection test' : 'Disabled from settings') }),
      () => toast.success(enabled ? `${g.name} is now offered at checkout` : `${g.name} disabled`),
    );

  const lastTest = c?.last_test;
  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <div className="flex items-center gap-3">
          <Monogram g={g} size="lg" />
          <div className="min-w-0">
            <SheetTitle>{g.name}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3">
              <a href={g.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                Website <ExternalLink className="size-3" />
              </a>
              <a href={g.docs_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                API docs <ExternalLink className="size-3" />
              </a>
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="flex-1 space-y-6 p-4">
        {c && (
          <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="font-medium">Offer at checkout</p>
              <p className="text-muted-foreground text-xs">{c.enabled ? `On — ${c.environment === 'LIVE' ? 'live payments' : 'test mode'}` : 'Needs a passing connection test first'}</p>
            </div>
            <Switch checked={c.enabled} disabled={!canEdit || busy !== null || (!c.enabled && !(lastTest?.ok && lastTest.environment === c.environment))} onCheckedChange={(v) => void toggle(v)} aria-label="Offer at checkout" />
          </div>
        )}

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" /> Credentials
          </h3>
          <div className="bg-muted grid h-9 grid-cols-2 rounded-lg p-0.5" role="radiogroup" aria-label="Environment">
            {(['TEST', 'LIVE'] as const).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={env === e} onClick={() => setEnv(e)} disabled={!canEdit} className={cn('rounded-md text-sm font-medium transition-colors', env === e ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                {e === 'TEST' ? 'Test / sandbox' : 'Live'}
              </button>
            ))}
          </div>
          {envDiffers && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Saving switches {g.name} to {env === 'LIVE' ? 'live' : 'test'} mode; test the connection again before payments use it.</p>}
          {g.credential_fields.map((f) => {
            const has = saved[f.key];
            const visible = !f.secret || show[f.key];
            return (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`gw-${f.key}`} className="flex items-center justify-between">
                  <span>
                    {f.label} {f.optional && <span className="text-muted-foreground font-normal">(optional)</span>}
                  </span>
                  {has && <span className="text-muted-foreground font-mono text-[11px] font-normal">saved {has}</span>}
                </Label>
                <div className="relative">
                  <Input
                    id={`gw-${f.key}`}
                    type={visible ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!canEdit}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={has ? 'Leave empty to keep the saved value' : ''}
                    className={cn('font-mono text-sm', f.secret && 'pr-10')}
                  />
                  {f.secret && (
                    <button type="button" onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))} className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 p-1" aria-label={visible ? `Hide ${f.label}` : `Show ${f.label}`}>
                      {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  )}
                </div>
                {f.help && <p className="text-muted-foreground text-[11px] leading-relaxed">{f.help}</p>}
              </div>
            );
          })}
          <div className="grid grid-cols-[120px_1fr] items-start gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gw-priority">Priority</Label>
              <Input id="gw-priority" value={priority} onChange={(e) => setPriority(e.target.value.replace(/\D/g, ''))} disabled={!canEdit} inputMode="numeric" />
            </div>
            <p className="text-muted-foreground pt-7 text-[11px] leading-relaxed">Lower goes first when several gateways are enabled; the next one is the fallback.</p>
          </div>
          {canEdit && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="gw-reason">Reason (audit log)</Label>
                <Textarea id="gw-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Onboarding Razorpay test keys" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!dirty || missing.length > 0 || reason.trim().length < 5 || busy !== null} onClick={() => void save()}>
                  {busy === 'save' && <Loader2 className="size-4 animate-spin" />} Save credentials
                </Button>
                <Button variant="outline" disabled={!c || busy !== null || (envDiffers && !Object.keys(saved).length)} onClick={() => void test()}>
                  {busy === 'test' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Test connection
                </Button>
              </div>
              {missing.length > 0 && !c && <p className="text-muted-foreground text-xs">Needed: {missing.map((m) => m.label).join(', ')}</p>}
            </>
          )}
          {lastTest && (
            <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', lastTest.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5')}>
              {lastTest.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose-600" />}
              <div className="min-w-0">
                <p className="font-medium">{lastTest.ok ? `Connected (${lastTest.environment === 'LIVE' ? 'live' : 'test'})` : 'Connection failed'}</p>
                <p className="text-muted-foreground text-xs break-words">{lastTest.ok ? `${lastTest.latency_ms} ms · ${formatRelative(lastTest.at)}` : lastTest.message}</p>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Webhook className="size-4" /> Callbacks
          </h3>
          <div className="space-y-1.5">
            <Label>Webhook URL</Label>
            <div className="bg-muted/50 flex items-center gap-2 rounded-lg border px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">{g.webhook_url}</code>
              <CopyButton value={g.webhook_url} label="Webhook URL" />
            </div>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{g.webhook_setup}</p>
          <p className="text-muted-foreground text-xs leading-relaxed">Customers come back to <code className="text-[11px]">{g.return_url}</code> — set automatically on every payment; every outcome is confirmed with {g.name} server-to-server.</p>
        </section>

        {(g.notes.length > 0 || !g.refunds_by_api) && (
          <section className="space-y-2">
            {g.notes.map((n) => (
              <p key={n} className="text-muted-foreground flex items-start gap-2 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0" /> {n}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
