'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Receipt, Search, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { api, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import {
  type AgentDirection,
  type AgentReceipt,
  type AgentTxn,
  type AgentTxnStatus,
  type AgentTxnType,
  fmtMobile,
  inr,
  istDateTime,
  MODE_LABEL,
  NEXT_STATUSES,
  presetDates,
  RANGE_PRESETS,
  type RangePreset,
  STATUS_LABEL,
  STATUSES,
  TXN_TYPES,
  TYPE_LABEL,
} from './api';
import { TxnRow, TxnStatus } from './bits';
import { AGENT_KEY, TXNS_KEY } from './hooks';
import { ReceiptActions } from './receipt-actions';

interface Filters {
  preset: RangePreset | 'all' | 'custom';
  from: string;
  to: string;
  type: AgentTxnType | 'ALL';
  direction: AgentDirection | 'ALL';
  status: AgentTxnStatus | 'ALL';
  search: string;
}

const ALL: Filters = { preset: 'all', from: '', to: '', type: 'ALL', direction: 'ALL', status: 'ALL', search: '' };

/** Transactions with filters and "load more" paging. With `customerId`, one customer's history only. */
export function TransactionsList({ customerId, compact = false }: { customerId?: string; compact?: boolean }) {
  const [f, setF] = useState<Filters>(ALL);
  const [term, setTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const query = {
    from: f.from || undefined,
    to: f.to || undefined,
    type: f.type === 'ALL' ? undefined : f.type,
    direction: f.direction === 'ALL' ? undefined : f.direction,
    status: f.status === 'ALL' ? undefined : f.status,
    search: f.search || undefined,
    customer_id: customerId,
    limit: 25,
  };
  const list = useInfiniteQuery({
    queryKey: [...TXNS_KEY, 'list', query],
    queryFn: ({ pageParam }) => apiRequest<AgentTxn[]>('/v1/agent/transactions', { query: { ...query, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  const setPreset = (p: RangePreset | 'all') => setF((x) => ({ ...x, preset: p, ...(p === 'all' ? { from: '', to: '' } : presetDates(p)) }));
  const active = (f.type !== 'ALL' ? 1 : 0) + (f.direction !== 'ALL' ? 1 : 0) + (f.status !== 'ALL' ? 1 : 0) + (f.preset === 'custom' ? 1 : 0);

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
              <Input
                aria-label="Search transactions"
                placeholder="Receipt no, name, mobile, UTR"
                className="h-11 pl-9"
                value={term}
                onChange={(e) => {
                  const v = e.target.value;
                  setTerm(v);
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => setF((x) => ({ ...x, search: v.trim() })), 300);
                }}
              />
            </div>
            <Button variant={showFilters ? 'secondary' : 'outline'} className="h-11" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              <SlidersHorizontal /> Filters{active ? ` (${active})` : ''}
            </Button>
          </div>
          <div className="-mx-4 overflow-x-auto px-4">
            <div className="flex min-w-max gap-2" role="group" aria-label="Date range">
              {[{ id: 'all' as const, label: 'All' }, ...RANGE_PRESETS].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={f.preset === p.id}
                  onClick={() => setPreset(p.id)}
                  className={cn('min-h-9 rounded-full border px-3.5 text-sm font-medium', f.preset === p.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card hover:border-primary/50')}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {showFilters && (
            <div className="bg-card grid gap-3 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5">
                <Label htmlFor="f-from">From</Label>
                <Input id="f-from" type="date" value={f.from} max={f.to || undefined} onChange={(e) => setF((x) => ({ ...x, preset: 'custom', from: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="f-to">To</Label>
                <Input id="f-to" type="date" value={f.to} min={f.from || undefined} onChange={(e) => setF((x) => ({ ...x, preset: 'custom', to: e.target.value }))} />
              </div>
              <FilterSelect id="f-type" label="Type" value={f.type} onChange={(v) => setF((x) => ({ ...x, type: v as Filters['type'] }))} options={TXN_TYPES.map((t) => [t, TYPE_LABEL[t]])} />
              <FilterSelect
                id="f-dir"
                label="Money"
                value={f.direction}
                onChange={(v) => setF((x) => ({ ...x, direction: v as Filters['direction'] }))}
                options={[
                  ['IN', 'In'],
                  ['OUT', 'Out'],
                ]}
              />
              <FilterSelect id="f-status" label="Status" value={f.status} onChange={(v) => setF((x) => ({ ...x, status: v as Filters['status'] }))} options={STATUSES.map((s) => [s, STATUS_LABEL[s]])} />
              {active > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-self-start sm:col-span-2 lg:col-span-5"
                  onClick={() => {
                    setF({ ...ALL, search: f.search });
                  }}
                >
                  <X /> Clear filters
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="bg-card overflow-hidden rounded-xl border">
        {list.isError ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
            <Receipt className="size-6" aria-hidden />
            {f.search || active || f.preset !== 'all' ? 'No entries match these filters.' : 'No entries yet.'}
          </div>
        ) : (
          <ul className={cn('divide-y', list.isFetching && !list.isFetchingNextPage && 'opacity-60')}>
            {rows.map((t) => (
              <li key={t.id}>
                <TxnRow t={t} onClick={() => setOpenId(t.id)} />
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="border-t p-3">
            <Button variant="outline" className="h-11 w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
            </Button>
          </div>
        )}
      </div>
      <TransactionDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All</SelectItem>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-3 px-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('col-span-2 break-all', mono && 'font-mono text-xs leading-5')}>{children ?? '—'}</dd>
    </div>
  );
}

/** One entry: details, receipt actions and (owner only) status change. */
export function TransactionDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const can = useCan();
  const q = useQuery({ queryKey: [...TXNS_KEY, id, 'receipt'], queryFn: () => api.get<AgentReceipt>(`/v1/agent/transactions/${id}/receipt`), enabled: Boolean(id) });
  const r = q.data;
  const t = r?.transaction;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{t ? `${r.type_label} · ${t.receipt_no}` : 'Transaction'}</SheetTitle>
          <SheetDescription asChild>
            <div>{t ? istDateTime(t.occurred_at) : ' '}</div>
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {q.isError ? (
            <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
          ) : !t ? (
            <Skeleton className="h-80" />
          ) : (
            <>
              <div className="flex items-center justify-between rounded-xl border p-4">
                <div>
                  <p className="text-muted-foreground text-xs">{t.direction === 'IN' ? 'Customer paid' : 'Customer got'}</p>
                  <p className="text-2xl font-semibold tabular-nums">{inr(t.total)}</p>
                </div>
                <TxnStatus status={t.status} />
              </div>
              <dl className="divide-y rounded-lg border">
                <Field label="Amount">{inr(t.amount)}</Field>
                <Field label="Service charge">{inr(t.fee)}</Field>
                <Field label="Mode">{MODE_LABEL[t.mode]}</Field>
                <Field label="Reference" mono>
                  {t.reference}
                </Field>
                <Field label="Customer">
                  {t.customer ? (
                    t.customer.id ? (
                      <Link href={`/agent/customers/${t.customer.id}`} className="text-primary hover:underline">
                        {t.customer.name}
                      </Link>
                    ) : (
                      t.customer.name
                    )
                  ) : null}
                  {t.customer?.mobile ? <span className="text-muted-foreground block text-xs">{fmtMobile(t.customer.mobile)}</span> : null}
                </Field>
                {t.beneficiary && (
                  <Field label="Beneficiary">
                    {t.beneficiary.name}
                    <span className="text-muted-foreground block text-xs">
                      {[t.beneficiary.bank_name, t.beneficiary.account_masked, t.beneficiary.ifsc, t.beneficiary.upi_id].filter(Boolean).join(' · ')}
                    </span>
                  </Field>
                )}
                <Field label="Note">{t.description}</Field>
                <Field label="Recorded by">{t.created_by}</Field>
                {t.status_changed_at && (
                  <Field label="Status changed">
                    {istDateTime(t.status_changed_at)}
                    {t.status_note ? <span className="text-muted-foreground block text-xs">{t.status_note}</span> : null}
                  </Field>
                )}
                {t.receipt_sent_at && <Field label="Receipt sent">{istDateTime(t.receipt_sent_at)}</Field>}
              </dl>
              <div className="space-y-2">
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/agent/receipts/${t.id}`}>
                    <ExternalLink /> Open receipt
                  </Link>
                </Button>
                <ReceiptActions
                  receipt={r}
                  onPrint={() => {
                    window.open(`/agent/receipts/${t.id}`, '_blank', 'noopener');
                  }}
                />
              </div>
              {can('agent.txn.manage') && NEXT_STATUSES[t.status].length > 0 && <StatusChange key={t.status} txn={t} />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatusChange({ txn }: { txn: AgentTxn }) {
  const qc = useQueryClient();
  const options = NEXT_STATUSES[txn.status];
  const [status, setStatus] = useState<AgentTxnStatus>(options[0]!);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/agent/transactions/${txn.id}/status`, { status, note: note.trim() || null, ...(reference.trim() ? { reference: reference.trim() } : {}) });
      toast.success(`Marked ${STATUS_LABEL[status].toLowerCase()}`);
      setNote('');
      setReference('');
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-semibold">Change status</h3>
      <FormError error={error} />
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="New status">
        {options.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={status === s}
            onClick={() => setStatus(s)}
            className={cn('min-h-11 rounded-lg border text-sm font-medium', status === s ? 'border-primary bg-primary/5 ring-primary ring-1' : 'hover:border-primary/50')}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {status === 'SUCCESS' && !txn.reference && (
        <div className="space-y-1.5">
          <Label htmlFor="st-ref">Reference (UTR / RRN)</Label>
          <Input id="st-ref" className="font-mono" maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="st-note">Note</Label>
        <Textarea id="st-note" rows={2} maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} placeholder={status === 'REFUNDED' ? 'How was the money returned?' : 'Why is it changing?'} />
      </div>
      <p className="text-muted-foreground text-xs">Failed and refunded entries are final and left out of totals.</p>
      <Button className="h-11 w-full" variant={status === 'SUCCESS' ? 'default' : 'destructive'} disabled={busy || (status !== 'SUCCESS' && note.trim().length < 3)} onClick={() => void save()}>
        {busy && <Loader2 className="animate-spin" />} Mark {STATUS_LABEL[status].toLowerCase()}
      </Button>
    </section>
  );
}
