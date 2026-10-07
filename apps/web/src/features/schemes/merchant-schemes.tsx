'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Layers, Loader2, Search, Star, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PricingSource, SchemeMerchantRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { SCHEMES_KEY, useSchemes } from './shared';

const MERCHANTS_KEY = ['scheme-merchants'];
const DEFAULT = '__default__';

export function EffectiveBadge({ source, name }: { source: PricingSource; name: string | null }) {
  const map: Record<PricingSource, { cls: string; label: string }> = {
    ASSIGNED_SCHEME: { cls: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300', label: 'Assigned' },
    DEFAULT_SCHEME: { cls: 'bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300', label: 'Default' },
    RATE_CARD: { cls: 'bg-muted text-muted-foreground ring-border', label: 'Rate card' },
    NONE: { cls: 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300', label: 'No pricing' },
  };
  const m = map[source];
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', m.cls)}>
      <span className="opacity-75">{m.label}</span>
      {name && <span className="truncate">· {name}</span>}
    </span>
  );
}

/** A reason dialog shared by every assignment action. */
function ReasonDialog({ title, description, confirm, busy, onConfirm, onClose, children }: { title: string; description: React.ReactNode; confirm: string; busy: boolean; onConfirm: (reason: string) => void; onClose: () => void; children?: React.ReactNode }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
        </DialogHeader>
        {children}
        <div className="space-y-1.5">
          <Label htmlFor="assign-reason">Reason (recorded in the audit log)</Label>
          <Textarea id="assign-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || reason.trim().length < 5} onClick={() => onConfirm(reason.trim())}>
            {busy && <Loader2 className="size-4 animate-spin" />} {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { kind: 'default'; schemeId: string | null } | { kind: 'all'; schemeId: string | null; includeResellers: boolean } | { kind: 'some'; schemeId: string | null; ids: string[] };

export function MerchantSchemes() {
  const schemes = useSchemes();
  const qc = useQueryClient();
  const can = useCan();
  const canManage = can('pricing.manage');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState('');
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);
  const [allTarget, setAllTarget] = useState('');
  const [includeResellers, setIncludeResellers] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const merchants = useInfiniteQuery({
    queryKey: [...MERCHANTS_KEY, q, filter],
    queryFn: ({ pageParam }) => api.get<{ data: SchemeMerchantRow[]; total: number; next_cursor: string | null }>('/v1/schemes/merchants', { q: q || undefined, scheme: filter === 'all' ? undefined : filter, limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });

  const active = (schemes.data?.schemes ?? []).filter((s) => s.status === 'ACTIVE');
  const current = active.find((s) => s.is_default);
  const chosenDefault = defaultChoice ?? (current?.id || DEFAULT);
  const nameOf = (id: string | null) => (id ? (active.find((s) => s.id === id)?.name ?? 'scheme') : 'the default scheme');
  const rows = merchants.data?.pages.flatMap((p) => p.data) ?? [];
  const total = merchants.data?.pages[0]?.total ?? 0;
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  async function run(reason: string) {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'default') {
        await api.post('/v1/schemes/default', { scheme_id: pending.schemeId, reason });
        toast.success(pending.schemeId ? `${nameOf(pending.schemeId)} is now the default scheme` : 'No default scheme: unassigned merchants use rate cards');
        setDefaultChoice(null);
      } else {
        const res = await api.post<{ updated: number }>('/v1/schemes/assign', {
          scheme_id: pending.schemeId,
          target: pending.kind === 'all' ? 'ALL' : 'MERCHANTS',
          merchant_ids: pending.kind === 'some' ? pending.ids : [],
          include_reseller_merchants: pending.kind === 'all' && pending.includeResellers,
          reason,
        });
        toast.success(`${res.updated.toLocaleString('en-IN')} merchant${res.updated === 1 ? '' : 's'} moved to ${nameOf(pending.schemeId)}`);
        setSelected(new Set());
        setBulkTarget('');
        setAllTarget('');
      }
      await Promise.all([qc.invalidateQueries({ queryKey: SCHEMES_KEY }), qc.invalidateQueries({ queryKey: MERCHANTS_KEY }), qc.invalidateQueries({ queryKey: ['merchant-pricing'] })]);
      setPending(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const schemeOptions = (
    <>
      <SelectItem value={DEFAULT}>Default scheme{current ? ` (${current.name})` : ''}</SelectItem>
      {active.map((s) => (
        <SelectItem key={s.id} value={s.id}>
          {s.name}
        </SelectItem>
      ))}
    </>
  );

  if (schemes.isError) return <ErrorState message={errorMessage(schemes.error)} onRetry={() => void schemes.refetch()} />;

  return (
    <div className="space-y-6 pb-20">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Star className="text-primary size-4" /> Default scheme
            </CardTitle>
            <CardDescription>New merchants, and merchants without an assigned scheme, join it automatically. Resellers’ merchants keep their reseller’s rate card.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Select value={chosenDefault} onValueChange={setDefaultChoice} disabled={!canManage || schemes.isLoading}>
              <SelectTrigger className="w-full sm:flex-1" aria-label="Default scheme">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>None — use rate cards</SelectItem>
                {active.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && (
              <Button disabled={chosenDefault === (current?.id || DEFAULT)} onClick={() => setPending({ kind: 'default', schemeId: chosenDefault === DEFAULT ? null : chosenDefault })}>
                Save default
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4" /> Apply to all merchants
            </CardTitle>
            <CardDescription>Move every direct merchant onto one scheme, or back to the default.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={allTarget} onValueChange={setAllTarget} disabled={!canManage}>
                <SelectTrigger className="w-full sm:flex-1" aria-label="Scheme for all merchants">
                  <SelectValue placeholder="Choose a scheme" />
                </SelectTrigger>
                <SelectContent>{schemeOptions}</SelectContent>
              </Select>
              {canManage && (
                <Button variant="outline" disabled={!allTarget} onClick={() => setPending({ kind: 'all', schemeId: allTarget === DEFAULT ? null : allTarget, includeResellers })}>
                  Apply to all
                </Button>
              )}
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Include resellers’ merchants <span className="text-muted-foreground text-xs">(replaces their reseller’s rate card; the reseller earns no margin)</span>
              </span>
              <Switch checked={includeResellers} onCheckedChange={setIncludeResellers} disabled={!canManage} aria-label="Include resellers’ merchants" />
            </label>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-5 [.border-b]:pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Merchants</CardTitle>
              <CardDescription>{total.toLocaleString('en-IN')} merchants · choose some to change their scheme</CardDescription>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <div className="relative sm:w-64">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID" className="pl-9" aria-label="Search merchants" />
              </div>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="sm:w-48" aria-label="Filter by scheme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All merchants</SelectItem>
                  <SelectItem value="none">No assigned scheme</SelectItem>
                  {active.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      On {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {merchants.isError ? (
            <div className="p-6">
              <ErrorState message={errorMessage(merchants.error)} onRetry={() => void merchants.refetch()} />
            </div>
          ) : merchants.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-sm">
              <Building2 className="size-6" /> No merchants match.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                  <tr>
                    {canManage && (
                      <th className="w-10 px-4 py-2.5">
                        <Checkbox
                          aria-label="Select all shown"
                          checked={allOnPage}
                          onCheckedChange={(v) => setSelected((cur) => {
                            const next = new Set(cur);
                            for (const r of rows) {
                              if (v) next.add(r.id);
                              else next.delete(r.id);
                            }
                            return next;
                          })}
                        />
                      </th>
                    )}
                    <th className="px-4 py-2.5 font-medium">Merchant</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Reseller</th>
                    <th className="px-4 py-2.5 font-medium">Assigned scheme</th>
                    <th className="px-4 py-2.5 font-medium">Pricing in effect</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((m) => (
                    <tr key={m.id} className={cn('hover:bg-muted/30 transition-colors', selected.has(m.id) && 'bg-primary/5')}>
                      {canManage && (
                        <td className="px-4 py-3">
                          <Checkbox
                            aria-label={`Select ${m.name}`}
                            checked={selected.has(m.id)}
                            onCheckedChange={(v) => setSelected((cur) => {
                              const next = new Set(cur);
                              if (v) next.add(m.id);
                              else next.delete(m.id);
                              return next;
                            })}
                          />
                        </td>
                      )}
                      <td className="max-w-[16rem] px-4 py-3">
                        <Link href={`/admin/merchants/${m.id}`} className="block truncate font-medium hover:underline">
                          {m.name}
                        </Link>
                        <span className="text-muted-foreground flex items-center gap-2 font-mono text-[11px]">
                          {m.id}
                          <StatusBadge status={m.status} className="font-sans" />
                        </span>
                      </td>
                      <td className="text-muted-foreground hidden px-4 py-3 md:table-cell">{m.reseller?.name ?? 'Direct'}</td>
                      <td className="px-4 py-3">
                        {m.scheme ? (
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Layers className="text-primary size-3.5" />
                            {m.scheme.name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="max-w-[14rem] px-4 py-3">
                        <EffectiveBadge source={m.effective.source} name={m.effective.name} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {merchants.hasNextPage && (
                <div className="border-t p-3 text-center">
                  <Button variant="ghost" size="sm" disabled={merchants.isFetchingNextPage} onClick={() => void merchants.fetchNextPage()}>
                    {merchants.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />} Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {canManage && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border p-2.5 shadow-lg backdrop-blur">
            <span className="bg-primary text-primary-foreground rounded-md px-2 py-1 text-xs font-semibold tabular-nums">{selected.size}</span>
            <span className="text-sm font-medium">selected</span>
            <Select value={bulkTarget} onValueChange={setBulkTarget}>
              <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Scheme for selected merchants">
                <SelectValue placeholder="Move to scheme…" />
              </SelectTrigger>
              <SelectContent>{schemeOptions}</SelectContent>
            </Select>
            <Button size="sm" disabled={!bulkTarget} onClick={() => setPending({ kind: 'some', schemeId: bulkTarget === DEFAULT ? null : bulkTarget, ids: [...selected] })}>
              Assign
            </Button>
            <Button size="icon" variant="ghost" className="size-8" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {pending && (
        <ReasonDialog
          title={pending.kind === 'default' ? 'Change the default scheme?' : pending.kind === 'all' ? `Move all merchants to ${nameOf(pending.schemeId)}?` : `Move ${pending.ids.length} merchant${pending.ids.length === 1 ? '' : 's'} to ${nameOf(pending.schemeId)}?`}
          description={
            pending.kind === 'default'
              ? pending.schemeId
                ? `${nameOf(pending.schemeId)} will price every merchant that has no assigned scheme, from its next transaction.`
                : 'Merchants without an assigned scheme will be priced by the platform rate card.'
              : pending.kind === 'all'
                ? `Every direct merchant${pending.includeResellers ? ' and every reseller’s merchant' : ''} gets this scheme from its next transaction. Fees already charged don’t change.`
                : 'Applies from each merchant’s next transaction. Fees already charged don’t change.'
          }
          confirm={pending.kind === 'default' ? 'Save default' : 'Assign'}
          busy={busy}
          onConfirm={(r) => void run(r)}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
