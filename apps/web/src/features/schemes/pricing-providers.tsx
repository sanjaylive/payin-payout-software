'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Check, Layers, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PricingProviderRow, PricingService } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { methodLabel, PRICING_METHODS, PROVIDERS_KEY, ProviderNo, SCHEMES_KEY, ServiceTag, usePricingProviders } from './shared';

/** Settings → Pricing Providers: the numbered lines (1 = Payout, 2 = Dynamic QR, …) that schemes price. */
export function PricingProviders() {
  const q = usePricingProviders();
  const can = useCan();
  const canEdit = can('system.settings.manage');
  const [editing, setEditing] = useState<PricingProviderRow | 'new' | null>(null);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  const taken = (service: PricingService, self?: number) => new Map(rows.filter((r) => r.service === service && r.is_active && r.id !== self).flatMap((r) => r.methods.map((m) => [m, r] as const)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Each provider has a number and covers payin methods or payout modes. Schemes set a charge or commission per provider number, and every transaction is priced by the provider that covers its method.
        </p>
        {canEdit && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Add provider
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => (
            <div key={p.id} className={cn('bg-card flex flex-col gap-3 rounded-xl border p-4 transition-shadow hover:shadow-sm', !p.is_active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <ProviderNo id={p.id} className="h-8 min-w-8 text-sm" />
                  <div>
                    <p className="leading-tight font-semibold">{p.name}</p>
                    <ServiceTag service={p.service} />
                  </div>
                </div>
                {canEdit && (
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                    <Pencil className="size-4" />
                  </Button>
                )}
              </div>
              {p.description && <p className="text-muted-foreground text-xs">{p.description}</p>}
              <div className="flex flex-wrap gap-1.5">
                {p.methods.map((m) => (
                  <span key={m} className="bg-muted rounded-md px-2 py-0.5 text-xs font-medium">
                    {methodLabel(m)}
                  </span>
                ))}
              </div>
              <div className="text-muted-foreground mt-auto flex items-center justify-between border-t pt-3 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3.5" />
                  {p.used_by_schemes ? `Priced in ${p.used_by_schemes} scheme${p.used_by_schemes === 1 ? '' : 's'}` : 'Not in any scheme yet'}
                </span>
                <span className={cn('inline-flex items-center gap-1 font-medium', p.is_active ? 'text-emerald-600 dark:text-emerald-400' : '')}>
                  <span className={cn('size-1.5 rounded-full', p.is_active ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                  {p.is_active ? 'Active' : 'Off'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <ProviderDialog key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} provider={editing === 'new' ? null : editing} taken={taken} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProviderDialog({ provider, taken, onClose }: { provider: PricingProviderRow | null; taken: (s: PricingService, self?: number) => Map<string, PricingProviderRow>; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(provider?.name ?? '');
  const [service, setService] = useState<PricingService>(provider?.service ?? 'PAYIN');
  const [methods, setMethods] = useState<string[]>(provider?.methods ?? []);
  const [description, setDescription] = useState(provider?.description ?? '');
  const [active, setActive] = useState(provider?.is_active ?? true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const locked = !!provider && provider.used_by_schemes > 0;
  const others = taken(service, provider?.id);

  function toggle(m: string) {
    setMethods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  }

  async function run(kind: 'save' | 'remove') {
    setBusy(kind);
    try {
      if (kind === 'remove') {
        await api.post(`/v1/pricing-providers/${provider!.id}/remove`, { reason });
        toast.success(`Provider #${provider!.id} removed`);
      } else {
        const body = { name, service, methods, description: description.trim() || null, is_active: active, reason };
        const saved = provider ? await api.put<PricingProviderRow>(`/v1/pricing-providers/${provider.id}`, body) : await api.post<PricingProviderRow>('/v1/pricing-providers', body);
        toast.success(provider ? `Provider #${saved.id} saved` : `Provider #${saved.id} added — you can now price it in schemes`);
      }
      await qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      await qc.invalidateQueries({ queryKey: SCHEMES_KEY });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const valid = name.trim().length >= 2 && methods.length > 0 && reason.trim().length >= 5;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {provider ? (
              <>
                <ProviderNo id={provider.id} /> Edit {provider.name}
              </>
            ) : (
              'Add pricing provider'
            )}
          </DialogTitle>
          <DialogDescription>{provider ? 'Changes apply to transactions created from now on.' : 'It gets the next free number. Then add its rates in each scheme.'}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pp-name">Name</Label>
            <Input id="pp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Virtual Account" maxLength={80} />
          </div>

          <div className="space-y-1.5">
            <Label>Service</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Service">
              {(['PAYIN', 'PAYOUT'] as const).map((s) => {
                const Icon = s === 'PAYIN' ? ArrowDownLeft : ArrowUpRight;
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={service === s}
                    disabled={locked}
                    onClick={() => {
                      setService(s);
                      setMethods([]);
                    }}
                    className={cn('flex items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60', service === s ? 'border-primary bg-primary/5 ring-primary/20 ring-2' : 'hover:bg-muted/50')}
                  >
                    <Icon className="size-4" />
                    <span className="font-medium">{s === 'PAYIN' ? 'Payin (collections)' : 'Payout (transfers)'}</span>
                  </button>
                );
              })}
            </div>
            {locked && <p className="text-muted-foreground text-[11px]">Locked: schemes already price this provider.</p>}
          </div>

          <div className="space-y-1.5">
            <Label>{service === 'PAYIN' ? 'Payin methods' : 'Payout modes'} it covers</Label>
            <div className="flex flex-wrap gap-2">
              {PRICING_METHODS[service].map((m) => {
                const on = methods.includes(m.value);
                const owner = others.get(m.value);
                return (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={on}
                    disabled={!!owner && !on}
                    onClick={() => toggle(m.value)}
                    title={owner ? `Already covered by #${owner.id} ${owner.name}` : undefined}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {on && <Check className="size-3" />}
                    {m.label}
                    {owner && !on && <span className="opacity-70">· #{owner.id}</span>}
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-[11px]">A method can belong to one active provider only. Static QR is ready for pricing; static QR collections are not live yet.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pp-desc">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input id="pp-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-muted-foreground text-xs">Switched off, it can’t be added to schemes and its methods are free for another provider.</p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} aria-label="Active" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pp-reason">Reason for this change</Label>
            <Textarea id="pp-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit log" />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {provider && provider.used_by_schemes === 0 ? (
            <Button variant="ghost" className="text-destructive" disabled={!!busy || reason.trim().length < 5} onClick={() => void run('remove')}>
              {busy === 'remove' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid || !!busy} onClick={() => void run('save')}>
              {busy === 'save' && <Loader2 className="size-4 animate-spin" />}
              {provider ? 'Save' : 'Add provider'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
