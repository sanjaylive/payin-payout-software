'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, CheckCircle2, Clock3, FileText, ImageIcon, Inbox, Landmark, Loader2, MinusCircle, PlusCircle, Search, Smartphone, Wallet, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { useBalances } from '@/features/ledger/balance-cards';
import { api, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { FundRequest, FundRequestStatus } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { CopyButton, FUND_REQUESTS_KEY, FUND_SUMMARY_KEY, FundStatus, inr, MODE_LABEL, useAuthedBlob, useFundSummary } from './shared';

type Tab = FundRequestStatus | 'ALL';

function Stat({ icon: Icon, label, value, hint, tone }: { icon: typeof Clock3; label: string; value: string; hint?: string; tone: string }) {
  return (
    <div className="bg-card flex items-center gap-4 rounded-xl border p-4">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', tone)}>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="truncate text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
    </div>
  );
}

/** Admin → Fund Requests: the approval queue, plus direct wallet credit / debit. */
export function FundRequestsAdmin() {
  const summary = useFundSummary();
  const can = useCan();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('request');
  const [tab, setTab] = useState<Tab>('PENDING');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [adjusting, setAdjusting] = useState(false);
  const [merchantFilter, setMerchantFilter] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: [...FUND_REQUESTS_KEY, 'admin', tab, q, merchantFilter],
    queryFn: ({ pageParam }) => apiRequest<FundRequest[]>('/v1/funds/requests', { query: { status: tab === 'ALL' ? undefined : tab, q: q || undefined, merchant_id: merchantFilter ?? undefined, limit: 25, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const open = (id: string | null) => router.replace(id ? `/admin/funds?request=${id}` : '/admin/funds', { scroll: false });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: FUND_REQUESTS_KEY }), qc.invalidateQueries({ queryKey: FUND_SUMMARY_KEY }), qc.invalidateQueries({ queryKey: ['balances'] })]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Clock3} label="Waiting for review" value={String(summary.data?.pending_count ?? '—')} hint={summary.data ? inr(summary.data.pending_amount) : undefined} tone="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
        <Stat icon={CheckCircle2} label="Approved today" value={summary.data ? inr(summary.data.approved_today_amount) : '—'} hint={summary.data ? `${summary.data.approved_today_count} request${summary.data.approved_today_count === 1 ? '' : 's'}` : undefined} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
        <div className="bg-card flex flex-col justify-center gap-2 rounded-xl border p-4 sm:col-span-2">
          <p className="text-sm font-medium">Change a merchant’s balance directly</p>
          <p className="text-muted-foreground text-xs">Credit or debit any merchant’s wallet with a reason. Large amounts follow your adjustment approval policy.</p>
          {can('ledger.adjust') && (
            <div>
              <Button size="sm" variant="outline" onClick={() => setAdjusting(true)}>
                <Wallet className="size-4" /> Add / deduct balance
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="PENDING">
                Pending
                {!!summary.data?.pending_count && <span className="bg-amber-500 ml-1.5 rounded-full px-1.5 text-[10px] font-semibold text-white tabular-nums">{summary.data.pending_count}</span>}
              </TabsTrigger>
              <TabsTrigger value="APPROVED">Approved</TabsTrigger>
              <TabsTrigger value="REJECTED">Rejected</TabsTrigger>
              <TabsTrigger value="ALL">All</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <MerchantCombobox value={merchantFilter} onChange={(m) => setMerchantFilter(m?.id ?? null)} anyLabel="All merchants" className="sm:w-60" ariaLabel="Filter by merchant" />
          <div className="relative w-full sm:w-56">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search UTR or request ID" className="pl-9" aria-label="Search fund requests" />
          </div>
          </div>
        </div>
        {list.isError ? (
          <div className="p-6">
            <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
          </div>
        ) : list.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-12 text-sm">
            <Inbox className="size-7" />
            {tab === 'PENDING' ? 'All caught up — no requests waiting.' : 'No requests here.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Merchant</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">UTR</th>
                  <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Paid into</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Submitted</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => open(r.id)} className="hover:bg-muted/40 cursor-pointer transition-colors">
                    <td className="max-w-[14rem] px-4 py-3">
                      <p className="truncate font-medium">{r.merchant_name}</p>
                      <p className="text-muted-foreground text-xs">{MODE_LABEL[r.mode]}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(r.amount)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{r.utr}</td>
                    <td className="text-muted-foreground hidden px-4 py-3 lg:table-cell">
                      <span className="inline-flex items-center gap-1.5">
                        {r.account.kind === 'UPI' ? <Smartphone className="size-3.5" /> : <Landmark className="size-3.5" />}
                        {r.account.label}
                      </span>
                    </td>
                    <td className="text-muted-foreground hidden px-4 py-3 md:table-cell" title={formatDateTime(r.created_at)}>
                      {formatRelative(r.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <FundStatus status={r.status} />
                        {r.has_proof && <ImageIcon className="text-muted-foreground size-3.5" aria-label="Has proof" />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.hasNextPage && (
              <div className="border-t p-3 text-center">
                <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />} Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && open(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">{openId && <Review key={openId} id={openId} canDecide={can('fund.approve')} onDone={refresh} />}</SheetContent>
      </Sheet>
      {adjusting && <AdjustDialog onClose={() => setAdjusting(false)} onDone={refresh} />}
    </div>
  );
}

function Review({ id, canDecide, onDone }: { id: string; canDecide: boolean; onDone: () => Promise<unknown> }) {
  const q = useQuery({ queryKey: [...FUND_REQUESTS_KEY, 'one', id], queryFn: () => api.get<FundRequest>(`/v1/funds/requests/${id}`) });
  const r = q.data;
  const proof = useAuthedBlob(r?.has_proof ? `/v1/funds/requests/${id}/proof` : null);
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [credited, setCredited] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!r) return <Skeleton className="m-4 h-96" />;
  const amountChanged = credited.trim() !== '' && credited.trim() !== r.amount && Number(credited) !== Number(r.amount);

  async function decide() {
    setBusy(true);
    try {
      const body = mode === 'approve' ? { decision: 'APPROVE', ...(amountChanged ? { credited_amount: credited.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } : { decision: 'REJECT', note: note.trim() };
      const res = await api.post<FundRequest>(`/v1/funds/requests/${id}/decision`, body);
      toast.success(mode === 'approve' ? `${inr(res.credited_amount)} added to ${r!.merchant_name}’s wallet` : 'Request rejected — the merchant has been told');
      setMode(null);
      await Promise.all([q.refetch(), onDone()]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, React.ReactNode][] = [
    ['Merchant', r.merchant_name],
    ['Requested', <span key="a" className="font-semibold tabular-nums">{inr(r.amount)}</span>],
    ...(r.credited_amount && r.credited_amount !== r.amount ? ([['Credited', <span key="c" className="font-semibold text-emerald-600 tabular-nums">{inr(r.credited_amount)}</span>]] as [string, React.ReactNode][]) : []),
    ['Mode', MODE_LABEL[r.mode]],
    [
      'UTR',
      <span key="u" className="inline-flex items-center gap-1 font-mono">
        {r.utr} <CopyButton value={r.utr} label="UTR" />
      </span>,
    ],
    ['Paid into', `${r.account.label} · ${r.account.kind === 'UPI' ? r.account.upi_id : r.account.account_number_masked}`],
    ['Paid at', formatDateTime(r.paid_at)],
    ['Submitted', formatDateTime(r.created_at)],
    ...(r.remarks ? ([['Remarks', r.remarks]] as [string, React.ReactNode][]) : []),
    ...(r.decided_at ? ([['Decided', formatDateTime(r.decided_at)]] as [string, React.ReactNode][]) : []),
    ...(r.decision_note ? ([['Note', r.decision_note]] as [string, React.ReactNode][]) : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle className="flex items-center gap-2">
          Fund request <FundStatus status={r.status} />
        </SheetTitle>
        <SheetDescription className="font-mono text-xs">{r.id}</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-5 p-4">
        <div className="from-primary/10 rounded-xl bg-gradient-to-br to-transparent p-4">
          <p className="text-muted-foreground text-xs font-medium">Amount</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{inr(r.amount)}</p>
        </div>
        <dl className="divide-y rounded-lg border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground shrink-0">{k}</dt>
              <dd className="min-w-0 text-right break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {r.has_proof && (
          <div>
            <p className="mb-2 text-sm font-medium">Payment proof</p>
            {!proof ? (
              <Skeleton className="h-48" />
            ) : proof.type === 'application/pdf' ? (
              <a href={proof.url} target="_blank" rel="noopener noreferrer" className="hover:bg-muted flex items-center gap-2 rounded-lg border p-3 text-sm">
                <FileText className="size-5" /> {r.proof_name ?? 'Open PDF'}
              </a>
            ) : (
              <a href={proof.url} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated blob preview */}
                <img src={proof.url} alt="Payment proof" className="max-h-80 w-full rounded-lg border object-contain" />
              </a>
            )}
          </div>
        )}
        <p className="text-muted-foreground text-xs">Check the UTR and amount against the bank or UPI statement of the account it was paid into before approving.</p>
      </div>

      {r.status === 'PENDING' && canDecide && (
        <div className="bg-background sticky bottom-0 space-y-3 border-t p-4">
          {mode && (
            <div className="space-y-3">
              {mode === 'approve' && (
                <div className="space-y-1.5">
                  <Label htmlFor="fr-credit">Amount to credit</Label>
                  <div className="relative">
                    <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">₹</span>
                    <Input id="fr-credit" value={credited} onChange={(e) => setCredited(e.target.value)} placeholder={r.amount} inputMode="decimal" className="pl-7 tabular-nums" />
                  </div>
                  {amountChanged && Number(credited) > Number(r.amount) ? (
                    <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">More than the merchant asked for — credit it only if the statement shows this amount.</p>
                  ) : (
                    <p className="text-muted-foreground text-[11px]">Leave as is to credit the full amount. If the statement shows a different amount, enter it with a note — the UTR can’t be submitted again.</p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="fr-note">{mode === 'reject' ? 'Reason (the merchant sees this)' : amountChanged ? 'Why the amount differs' : 'Note (optional)'}</Label>
                <Textarea id="fr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
          )}
          <div className="flex gap-2">
            {mode ? (
              <>
                <Button variant="outline" className="flex-1" onClick={() => setMode(null)}>
                  Back
                </Button>
                <Button className={cn('flex-1', mode === 'reject' && 'bg-destructive hover:bg-destructive/90 text-white')} disabled={busy || (mode === 'reject' ? note.trim().length < 5 : amountChanged && !note.trim())} onClick={() => void decide()}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {mode === 'approve' ? `Approve & credit ${inr(amountChanged ? credited : r.amount)}` : 'Reject request'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" className="text-destructive flex-1" onClick={() => setMode('reject')}>
                  <XCircle className="size-4" /> Reject
                </Button>
                <Button className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setMode('approve')}>
                  <CheckCircle2 className="size-4" /> Approve
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Direct credit / debit, through the ledger adjustment flow (maker-checker above the policy limit). */
function AdjustDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) {
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const bal = useBalances(merchantId ?? undefined);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post<{ status: string; approvals_required: number }>('/v1/ledger/adjustments', { merchant_id: merchantId, direction, amount: amount.trim(), reason: reason.trim(), reference: reference.trim() });
      if (res.status === 'POSTED') toast.success(`${direction === 'CREDIT' ? 'Added' : 'Deducted'} ${inr(amount)} ${direction === 'CREDIT' ? 'to' : 'from'} the wallet`);
      else toast.info(`Sent for approval — ${res.approvals_required} approver${res.approvals_required === 1 ? '' : 's'} needed (Ledger → Adjustments)`);
      await onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const valid = merchantId && /^\d+(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0 && reason.trim().length >= 10 && reference.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add or deduct balance</DialogTitle>
          <DialogDescription>Posts a balanced ledger adjustment to the merchant’s available balance. Every change is audited.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Merchant</Label>
            <MerchantCombobox value={merchantId} onChange={(m) => setMerchantId(m?.id ?? null)} status="APPROVED,SUSPENDED" placeholder="Search by name, PAN or ID" />
            {merchantId && <p className="text-muted-foreground text-xs">Available now: {bal.data ? <span className="text-foreground font-medium tabular-nums">{inr(bal.data.available)}</span> : '…'}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Direction">
            {(['CREDIT', 'DEBIT'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => setDirection(d)}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg border p-3 text-sm font-medium transition-colors',
                  direction === d ? (d === 'CREDIT' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300') : 'hover:bg-muted',
                )}
              >
                {d === 'CREDIT' ? <PlusCircle className="size-4" /> : <MinusCircle className="size-4" />}
                {d === 'CREDIT' ? 'Add balance' : 'Deduct balance'}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-amount">Amount</Label>
            <div className="relative">
              <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">₹</span>
              <Input id="adj-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="pl-7 tabular-nums" placeholder="0.00" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-ref">Reference</Label>
            <Input id="adj-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Ticket #4821 or bank UTR" maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-reason">Reason</Label>
            <Textarea id="adj-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 10 characters — recorded in the audit log" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void submit()} className={direction === 'DEBIT' ? 'bg-destructive hover:bg-destructive/90 text-white' : ''}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownLeft className="size-4" />}
            {direction === 'CREDIT' ? 'Add' : 'Deduct'} {amount ? inr(amount) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
