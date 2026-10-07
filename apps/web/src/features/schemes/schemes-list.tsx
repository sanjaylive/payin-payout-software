'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@pay2all/ui/components/ui/dropdown-menu';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, Copy, Layers, MoreHorizontal, Pencil, Plus, Star, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Scheme, SchemeRateRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { ProviderNo, rupees, SCHEMES_KEY, useSchemes, ValueBadge } from './shared';

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
    </div>
  );
}

const slab = (r: SchemeRateRow) => (r.max_amount === null ? `${rupees(r.min_amount)}+` : `${rupees(r.min_amount)} – ${rupees(r.max_amount)}`);

function SchemeCard({ s, canManage, onAction }: { s: Scheme; canManage: boolean; onAction: (a: 'default' | 'archive', s: Scheme) => void }) {
  const byProvider = new Map<number, SchemeRateRow[]>();
  for (const r of s.rates) byProvider.set(r.provider_id, [...(byProvider.get(r.provider_id) ?? []), r]);
  const archived = s.status === 'ARCHIVED';
  return (
    <div className={cn('bg-card group relative flex flex-col rounded-xl border transition-shadow hover:shadow-md', s.is_default && 'border-primary/50 ring-primary/15 ring-2', archived && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/admin/pricing/schemes/${s.id}`} className="truncate font-semibold hover:underline">
              {s.name}
            </Link>
            {s.is_default && (
              <span className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                <Star className="size-3 fill-current" /> Default
              </span>
            )}
            {archived && <span className="bg-muted rounded-full px-2 py-0.5 text-[11px] font-medium">Archived</span>}
          </div>
          {s.description && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{s.description}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Actions for ${s.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/admin/pricing/schemes/${s.id}`}>
                <Pencil className="size-4" /> {canManage && !archived ? 'Edit' : 'View'}
              </Link>
            </DropdownMenuItem>
            {canManage && (
              <DropdownMenuItem asChild>
                <Link href={`/admin/pricing/schemes/new?copy=${s.id}`}>
                  <Copy className="size-4" /> Duplicate
                </Link>
              </DropdownMenuItem>
            )}
            {canManage && !archived && !s.is_default && (
              <>
                <DropdownMenuItem onSelect={() => onAction('default', s)}>
                  <Star className="size-4" /> Make default
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onAction('archive', s)}>
                  <Archive className="size-4" /> Archive
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 space-y-2 px-4 pb-4">
        {byProvider.size === 0 && <p className="text-muted-foreground text-xs italic">No rates yet</p>}
        {[...byProvider.entries()].map(([pid, rates]) => (
          <div key={pid} className="bg-muted/40 rounded-lg p-2.5">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
              <ProviderNo id={pid} className="h-5 min-w-5 text-[10px]" />
              {rates[0]!.provider_name}
              <span className="text-muted-foreground ml-auto font-normal">
                {rates.length} slab{rates.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="space-y-1">
              {rates.slice(0, 3).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground tabular-nums">{slab(r)}</span>
                  <ValueBadge type={r.type} value={r.value} />
                </li>
              ))}
              {rates.length > 3 && <li className="text-muted-foreground text-[11px]">+{rates.length - 3} more</li>}
            </ul>
          </div>
        ))}
      </div>

      <div className="text-muted-foreground flex items-center gap-4 border-t px-4 py-2.5 text-xs">
        <span className="inline-flex items-center gap-1">
          <Users className="size-3.5" />
          {s.merchants} merchant{s.merchants === 1 ? '' : 's'}
          {s.is_default && ' + default'}
        </span>
        <span>GST {s.tax_rate}%</span>
        <span className="ml-auto">Updated {formatRelative(s.updated_at)}</span>
      </div>
    </div>
  );
}

/** Pricing → Schemes: every scheme as a card, with the default highlighted. */
export function SchemesList() {
  const q = useSchemes();
  const qc = useQueryClient();
  const can = useCan();
  const canManage = can('pricing.manage');
  const [action, setAction] = useState<{ kind: 'default' | 'archive'; s: Scheme } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data)
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    );

  const active = q.data.schemes.filter((s) => s.status === 'ACTIVE');
  const archived = q.data.schemes.filter((s) => s.status === 'ARCHIVED');
  const def = active.find((s) => s.is_default);
  const assigned = active.reduce((a, s) => a + s.merchants, 0);

  async function confirm(reason?: string) {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === 'default') await api.post('/v1/schemes/default', { scheme_id: action.s.id, reason });
      else await api.post(`/v1/schemes/${action.s.id}/archive`, { reason });
      toast.success(action.kind === 'default' ? `${action.s.name} is now the default scheme` : `${action.s.name} archived`);
      await qc.invalidateQueries({ queryKey: SCHEMES_KEY });
      setAction(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active schemes" value={active.length} hint={archived.length ? `${archived.length} archived` : undefined} />
        <Stat label="Default scheme" value={def ? def.name : <span className="text-muted-foreground">None</span>} hint={def ? 'Merchants without a scheme join it' : 'Unassigned merchants use rate cards'} />
        <Stat label="Merchants on a scheme" value={assigned.toLocaleString('en-IN')} hint={`${q.data.merchants_without_scheme.toLocaleString('en-IN')} without one`} />
      </div>

      {active.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
            <Layers className="size-6" />
          </span>
          <div>
            <p className="font-semibold">No schemes yet</p>
            <p className="text-muted-foreground text-sm">Create one to set charges or commissions per provider and amount slab.</p>
          </div>
          {canManage && (
            <Button asChild>
              <Link href="/admin/pricing/schemes/new">
                <Plus className="size-4" /> New scheme
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {active.map((s) => (
            <SchemeCard key={s.id} s={s} canManage={canManage} onAction={(kind, x) => setAction({ kind, s: x })} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowArchived((v) => !v)} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm font-medium">
            <ChevronDown className={cn('size-4 transition-transform', !showArchived && '-rotate-90')} /> Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {archived.map((s) => (
                <SchemeCard key={s.id} s={s} canManage={canManage} onAction={() => undefined} />
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        key={action ? `${action.kind}:${action.s.id}` : 'none'}
        open={!!action}
        onOpenChange={(o) => !o && setAction(null)}
        title={action?.kind === 'default' ? `Make “${action.s.name}” the default?` : `Archive “${action?.s.name}”?`}
        description={
          action?.kind === 'default'
            ? `Merchants without an assigned scheme${def ? ` (now on ${def.name})` : ''} will be priced by ${action.s.name} from their next transaction. Resellers’ merchants keep their reseller’s rate card.`
            : 'It will no longer be offered. Transactions already priced by it keep their recorded fees.'
        }
        confirmLabel={action?.kind === 'default' ? 'Make default' : 'Archive'}
        destructive={action?.kind === 'archive'}
        requireReason
        pending={busy}
        onConfirm={(reason) => void confirm(reason)}
      />
    </div>
  );
}
