'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Calculator, Info, Loader2, Plus, Save, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PricingProviderRow, Scheme } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { type DraftRate, describeValue, methodLabel, previewDraft, ProviderNo, rupees, SCHEMES_KEY, ServiceTag, usePricingProviders, ValueBadge } from './shared';

type Row = DraftRate & { key: string; providerId: number };

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()));
const plusPaisa = (major: string) => {
  const m = majorToMinor(major) + 1n;
  return `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;
};
const fromMinor = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;

/** Problems and gaps for one provider's slabs, computed exactly in paise. */
function analyse(rows: Row[]) {
  const errors = new Map<string, string>();
  const valid = rows.filter((r) => {
    if (!AMOUNT.test(r.min.trim())) errors.set(r.key, 'From must be an amount like 0 or 1000.00');
    else if (r.max.trim() && !AMOUNT.test(r.max.trim())) errors.set(r.key, 'To must be an amount, or empty for no limit');
    else if (r.max.trim() && majorToMinor(r.max) < majorToMinor(r.min)) errors.set(r.key, 'To must be at least From');
    else if (describeValue(r.type, r.value).kind === 'INVALID') errors.set(r.key, 'Enter a value like -2 (charge) or 0.5 (commission)');
    else if (r.type === 'FLAT' && !/^-?\d+(\.\d{1,2})?$/.test(r.value.trim())) errors.set(r.key, 'Flat values have at most 2 decimals');
    else if (r.type === 'PERCENT' && Math.abs(Number(r.value)) > 100) errors.set(r.key, 'A percentage can’t exceed 100');
    else return true;
    return false;
  });
  const sorted = [...valid].sort((a, b) => (majorToMinor(a.min) < majorToMinor(b.min) ? -1 : 1));
  const gaps: string[] = [];
  let cursor = 1n; // next uncovered amount in paise; ₹0.01 is the smallest real amount
  let prevMax: bigint | null | undefined; // undefined = no slab yet, null = open-ended
  for (const r of sorted) {
    const lo = majorToMinor(r.min);
    const hi = r.max.trim() ? majorToMinor(r.max) : null;
    if (prevMax === null || (prevMax !== undefined && lo <= prevMax)) {
      errors.set(r.key, prevMax === null ? 'Overlaps the open-ended slab before it' : 'Overlaps the slab before it');
    } else if (lo > cursor) gaps.push(`₹${fromMinor(cursor)} – ₹${fromMinor(lo - 1n)}`);
    if (prevMax !== null) prevMax = hi === null ? null : prevMax === undefined || hi > prevMax ? hi : prevMax;
    if (hi !== null && hi + 1n > cursor) cursor = hi + 1n;
  }
  if (sorted.length && prevMax !== null) gaps.push(`above ₹${fromMinor(cursor - 1n)}`);
  return { errors, gaps };
}

export function SchemeEditor({ schemeId, copyFrom }: { schemeId?: string; copyFrom?: string }) {
  const providers = usePricingProviders();
  const sourceId = schemeId ?? copyFrom;
  const source = useQuery({ queryKey: ['scheme', sourceId], queryFn: () => api.get<Scheme>(`/v1/schemes/${sourceId}`), enabled: !!sourceId });
  if (providers.isError || source.isError) return <ErrorState message={errorMessage(providers.error ?? source.error)} onRetry={() => void (providers.refetch(), source.refetch())} />;
  if (providers.isLoading || (sourceId && source.isLoading)) return <LoadingSkeleton rows={8} />;
  return <Form key={`${sourceId ?? 'new'}:${source.data?.version ?? 0}`} providers={providers.data ?? []} scheme={source.data} mode={schemeId ? 'edit' : 'new'} />;
}

function Form({ providers, scheme, mode }: { providers: PricingProviderRow[]; scheme?: Scheme; mode: 'edit' | 'new' }) {
  const router = useRouter();
  const qc = useQueryClient();
  const can = useCan();
  const readOnly = !can('pricing.manage') || scheme?.status === 'ARCHIVED';
  const [name, setName] = useState(mode === 'edit' ? (scheme?.name ?? '') : scheme ? `${scheme.name} (copy)` : '');
  const [description, setDescription] = useState(scheme?.description ?? '');
  const [taxRate, setTaxRate] = useState(scheme?.tax_rate ?? '18');
  const [rows, setRows] = useState<Row[]>(() => scheme?.rates.map((r) => ({ key: newKey(), providerId: r.provider_id, min: r.min_amount, max: r.max_amount ?? '', type: r.type, value: r.value })) ?? []);
  const [saving, setSaving] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');

  // Active providers, plus inactive ones this scheme already prices.
  const shown = providers.filter((p) => p.is_active || rows.some((r) => r.providerId === p.id));
  const analysis = new Map(shown.map((p) => [p.id, analyse(rows.filter((r) => r.providerId === p.id))]));
  const errorCount = [...analysis.values()].reduce((a, x) => a + x.errors.size, 0);
  const canSave = !readOnly && name.trim().length >= 2 && /^\d{1,3}(\.\d{1,4})?$/.test(taxRate) && errorCount === 0;

  const update = (key: string, patch: Partial<Row>) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function addSlab(providerId: number) {
    setRows((cur) => {
      const mine = cur.filter((r) => r.providerId === providerId);
      const last = [...mine].filter((r) => AMOUNT.test(r.max.trim())).sort((a, b) => (majorToMinor(a.max) < majorToMinor(b.max) ? 1 : -1))[0];
      const min = mine.length === 0 ? '0.00' : last ? plusPaisa(last.max) : '';
      return [...cur, { key: newKey(), providerId, min, max: '', type: 'FLAT', value: '-' }];
    });
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        tax_rate: taxRate,
        rates: rows.map((r) => ({ provider_id: r.providerId, min_amount: r.min.trim(), max_amount: r.max.trim() || null, type: r.type, value: r.value.trim() })),
        reason,
        ...(mode === 'edit' && scheme ? { version: scheme.version } : {}),
      };
      const saved = mode === 'edit' && scheme ? await api.put<Scheme>(`/v1/schemes/${scheme.id}`, body) : await api.post<Scheme>('/v1/schemes', body);
      toast.success(mode === 'edit' ? 'Scheme saved — new transactions use these rates' : `${saved.name} created`);
      await qc.invalidateQueries({ queryKey: SCHEMES_KEY });
      qc.setQueryData(['scheme', saved.id], saved);
      setReasonOpen(false);
      setReason('');
      if (mode === 'new') router.push(`/admin/pricing/schemes/${saved.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/admin/pricing" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" /> Schemes
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {mode === 'edit' ? scheme?.name : 'New scheme'}
            {scheme?.is_default && mode === 'edit' && (
              <span className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
                <Star className="size-3 fill-current" /> Default
              </span>
            )}
            {scheme?.status === 'ARCHIVED' && <span className="bg-muted rounded-full px-2 py-0.5 text-xs font-medium">Archived</span>}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Per provider, add amount slabs. A <strong className="text-rose-600 dark:text-rose-400">negative</strong> value is a charge to the merchant; a <strong className="text-emerald-600 dark:text-emerald-400">positive</strong> value is a commission paid to the merchant.
          </p>
        </div>
        {!readOnly && (
          <Button disabled={!canSave || saving} onClick={() => setReasonOpen(true)}>
            <Save className="size-4" /> {mode === 'edit' ? 'Save changes' : 'Create scheme'}
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card className="shadow-none">
            <CardContent className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <div className="space-y-1.5">
                <Label htmlFor="s-name">Scheme name</Label>
                <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gold, Retail, High volume" maxLength={80} disabled={readOnly} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-gst">GST on charges</Label>
                <div className="relative">
                  <Input id="s-gst" value={taxRate} onChange={(e) => setTaxRate(e.target.value.trim())} inputMode="decimal" className="pr-7" disabled={readOnly} />
                  <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">%</span>
                </div>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="s-desc">
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input id="s-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={readOnly} />
              </div>
            </CardContent>
          </Card>

          {shown.map((p) => {
            const mine = rows.filter((r) => r.providerId === p.id);
            const a = analysis.get(p.id)!;
            return (
              <Card key={p.id} className="gap-0 overflow-hidden pt-0 shadow-none">
                <CardHeader className="bg-muted/30 border-b pt-4 [.border-b]:pb-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <ProviderNo id={p.id} className="h-8 min-w-8 text-sm" />
                      <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                          {p.name}
                          {!p.is_active && <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">Switched off</span>}
                        </CardTitle>
                        <CardDescription className="flex flex-wrap items-center gap-x-2 text-xs">
                          <ServiceTag service={p.service} />
                          <span>·</span>
                          {p.methods.map(methodLabel).join(', ')}
                        </CardDescription>
                      </div>
                    </div>
                    {!readOnly && p.is_active && (
                      <Button variant="outline" size="sm" onClick={() => addSlab(p.id)}>
                        <Plus className="size-4" /> Add slab
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {mine.length === 0 ? (
                    <div className="text-muted-foreground flex items-center gap-2 px-6 py-5 text-sm">
                      <Info className="size-4 shrink-0" /> Not priced — merchants on this scheme can’t use {p.name}.
                    </div>
                  ) : (
                    <div className="divide-y">
                      <div className="text-muted-foreground hidden grid-cols-[1fr_1fr_112px_1fr_auto_36px] gap-3 px-6 py-2 text-[11px] font-medium tracking-wide uppercase md:grid">
                        <span>From (₹)</span>
                        <span>To (₹)</span>
                        <span>Type</span>
                        <span>Value</span>
                        <span className="w-40">Means</span>
                        <span />
                      </div>
                      {mine.map((r) => {
                        const err = a.errors.get(r.key);
                        return (
                          <div key={r.key} className="px-4 py-3 md:px-6">
                            <div className="grid grid-cols-2 items-center gap-3 md:grid-cols-[1fr_1fr_112px_1fr_auto_36px]">
                              <Input aria-label="From amount" value={r.min} onChange={(e) => update(r.key, { min: e.target.value })} inputMode="decimal" className="tabular-nums" disabled={readOnly} />
                              <Input aria-label="To amount" value={r.max} onChange={(e) => update(r.key, { max: e.target.value })} inputMode="decimal" placeholder="No limit" className="tabular-nums" disabled={readOnly} />
                              <div className="bg-muted inline-flex h-9 rounded-md p-0.5" role="radiogroup" aria-label="Value type">
                                {(['PERCENT', 'FLAT'] as const).map((t) => (
                                  <button
                                    key={t}
                                    type="button"
                                    role="radio"
                                    aria-checked={r.type === t}
                                    disabled={readOnly}
                                    onClick={() => update(r.key, { type: t })}
                                    className={cn('flex-1 rounded px-2.5 text-xs font-medium transition-colors', r.type === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                                  >
                                    {t === 'PERCENT' ? '%' : 'Flat ₹'}
                                  </button>
                                ))}
                              </div>
                              <div className="relative">
                                <Input
                                  aria-label="Value"
                                  value={r.value}
                                  onChange={(e) => update(r.key, { value: e.target.value.replace(/[^\d.-]/g, '') })}
                                  inputMode="decimal"
                                  placeholder={r.type === 'PERCENT' ? '-0.5' : '-2'}
                                  className={cn('pr-8 font-medium tabular-nums', r.value.trim().startsWith('-') ? 'text-rose-600 dark:text-rose-400' : r.value.trim() && 'text-emerald-600 dark:text-emerald-400')}
                                  disabled={readOnly}
                                />
                                <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">{r.type === 'PERCENT' ? '%' : '₹'}</span>
                              </div>
                              <div className="flex md:w-40">
                                <ValueBadge type={r.type} value={r.value} onFlip={readOnly ? undefined : () => update(r.key, { value: r.value.trim().startsWith('-') ? r.value.trim().slice(1) : `-${r.value.trim()}` })} />
                              </div>
                              {!readOnly && (
                                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-9 justify-self-end" aria-label="Remove slab" onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}>
                                  <Trash2 className="size-4" />
                                </Button>
                              )}
                            </div>
                            {err && <p className="text-destructive mt-1.5 text-xs">{err}</p>}
                          </div>
                        );
                      })}
                      {a.gaps.length > 0 && (
                        <div className="flex items-start gap-2 bg-amber-500/5 px-6 py-2.5 text-xs text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          <span>Not priced: {a.gaps.join(', ')}. Transactions in these ranges will be refused.</span>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Calculator_ providers={shown} rows={rows} taxRate={taxRate} />
          <Card className="shadow-none">
            <CardContent className="space-y-2 text-xs">
              <p className="text-sm font-medium">How values work</p>
              <div className="flex items-center justify-between gap-2">
                <code className="text-rose-600 dark:text-rose-400">-2</code> <ValueBadge type="FLAT" value="-2" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <code className="text-rose-600 dark:text-rose-400">-0.5</code> <ValueBadge type="PERCENT" value="-0.5" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <code className="text-emerald-600 dark:text-emerald-400">3</code> <ValueBadge type="FLAT" value="3" />
              </div>
              <p className="text-muted-foreground pt-1 leading-relaxed">
                GST is added to charges only. Commission on a payin is credited on top of the amount; on a payout it reduces the debit. A refund or bank return takes the commission back. Click a badge to flip charge ↔ commission.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'edit' ? 'Save scheme changes' : 'Create scheme'}</DialogTitle>
            <DialogDescription>
              {mode === 'edit' && scheme
                ? `Applies to new transactions of ${scheme.merchants} assigned merchant${scheme.merchants === 1 ? '' : 's'}${scheme.is_default ? ' and every merchant on the default scheme' : ''}. Fees already charged don’t change.`
                : 'You can assign it to merchants, or make it the default, once it is created.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="s-reason">Reason (recorded in the audit log)</Label>
            <Textarea id="s-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving || reason.trim().length < 5} onClick={() => void save()}>
              {saving && <Loader2 className="size-4 animate-spin" />} {mode === 'edit' ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Live "what would this cost" on the unsaved rates. */
function Calculator_({ providers, rows, taxRate }: { providers: PricingProviderRow[]; rows: Row[]; taxRate: string }) {
  const [pid, setPid] = useState<string>(String(providers[0]?.id ?? ''));
  const [amount, setAmount] = useState('1000');
  const p = providers.find((x) => String(x.id) === pid);
  const result = p ? previewDraft(rows.filter((r) => r.providerId === p.id), amount, taxRate, p.service) : null;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Calculator className="size-4" /> Try an amount
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={pid} onValueChange={setPid}>
          <SelectTrigger aria-label="Provider" className="w-full">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((x) => (
              <SelectItem key={x.id} value={String(x.id)}>
                #{x.id} {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">₹</span>
          <Input aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="decimal" className="pl-7 tabular-nums" />
        </div>
        {!result ? (
          <p className="text-muted-foreground text-xs">Enter an amount like 1000 or 2500.50</p>
        ) : !result.matched ? (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">No slab covers this amount — it would be refused.</p>
        ) : (
          <dl className="divide-y rounded-lg border text-sm">
            {[
              ['Amount', rupees(amount)],
              ['Charge', result.fee],
              ['GST', result.tax],
              ['Commission', result.commission],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-3 py-1.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={cn('tabular-nums', k === 'Commission' && result.kind === 'COMMISSION' && 'text-emerald-600 dark:text-emerald-400', k === 'Charge' && result.kind === 'CHARGE' && 'text-rose-600 dark:text-rose-400')}>{v}</dd>
              </div>
            ))}
            <div className="bg-muted/40 flex justify-between px-3 py-2 font-semibold">
              <dt>{p?.service === 'PAYOUT' ? 'Merchant debited' : 'Merchant credited'}</dt>
              <dd className="tabular-nums">{result.net}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
