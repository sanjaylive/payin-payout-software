'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ExternalLink, ImageUp, Info, Landmark, Loader2, Paperclip, QrCode, Smartphone, Wallet, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { PaymentQr } from '@/features/payin/payment-qr';
import { useBalances } from '@/features/ledger/balance-cards';
import { api, apiRequest, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { CollectionAccount, FundRequest } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { CopyButton, FUND_REQUESTS_KEY, FundStatus, inr, MODE_LABEL, upiPayload, useFundAccounts } from './shared';

const QUICK = ['1000', '5000', '10000', '50000'];
const STEPS = ['Amount', 'Pay', 'Confirm'] as const;
const AMOUNT = /^\d{1,11}(\.\d{1,2})?$/;

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-2">
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors', i < step ? 'bg-primary text-primary-foreground' : i === step ? 'border-primary text-primary border-2' : 'bg-muted text-muted-foreground')}>
            {i < step ? <Check className="size-3.5" /> : i + 1}
          </span>
          <span className={cn('text-xs font-medium', i === step ? 'text-foreground' : 'text-muted-foreground')}>{s}</span>
          {i < STEPS.length - 1 && <span className={cn('h-px flex-1', i < step ? 'bg-primary' : 'bg-border')} />}
        </li>
      ))}
    </ol>
  );
}

function Detail({ label, value, copy, mono }: { label: string; value: string | null | undefined; copy?: boolean; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className={cn('truncate text-sm font-medium', mono && 'font-mono tracking-wide')}>{value}</span>
        {copy && <CopyButton value={value} label={label} />}
      </span>
    </div>
  );
}

export function AddFunds() {
  const { data: me } = useMe();
  const can = useCan();
  const balances = useBalances(me?.organization.id);
  const accounts = useFundAccounts();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [utr, setUtr] = useState('');
  const [mode, setMode] = useState<FundRequest['mode']>('IMPS');
  const [paidAt, setPaidAt] = useState(localNow);
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<FundRequest | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = (accounts.data ?? []).filter((a) => a.is_active);
  const account = list.find((a) => a.id === accountId) ?? null;
  const n = Number(amount);
  const amountError = !amount
    ? null
    : !AMOUNT.test(amount)
      ? 'Enter an amount like 5000 or 2500.50'
      : n <= 0
        ? 'Must be more than zero'
        : account?.min_amount && n < Number(account.min_amount)
          ? `Minimum for this account is ${inr(account.min_amount)}`
          : account?.max_amount && n > Number(account.max_amount)
            ? `Maximum for this account is ${inr(account.max_amount)}`
            : null;
  const canNext = AMOUNT.test(amount) && n > 0 && !amountError && !!account;
  const note = `Wallet top-up ${me?.organization.name ?? ''}`.trim();

  function choose(a: CollectionAccount) {
    setAccountId(a.id);
    setMode(a.kind === 'UPI' ? 'UPI' : 'IMPS');
  }

  function reset() {
    setStep(0);
    setAmount('');
    setAccountId(null);
    setUtr('');
    setRemarks('');
    setProof(null);
    setPaidAt(localNow());
    setDone(null);
  }

  async function submit() {
    if (!account) return;
    setBusy(true);
    try {
      const created = await api.post<FundRequest>('/v1/funds/requests', { collection_account_id: account.id, amount, mode, utr: utr.trim(), paid_at: new Date(paidAt).toISOString(), remarks: remarks.trim() || null });
      if (proof) {
        const form = new FormData();
        form.append('file', proof);
        await apiUpload(`/v1/funds/requests/${created.id}/proof`, form).catch((err) => toast.warning(`Request sent, but the screenshot didn’t upload: ${errorMessage(err)}`));
      }
      setDone(created);
      await qc.invalidateQueries({ queryKey: FUND_REQUESTS_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (accounts.isError) return <ErrorState message={errorMessage(accounts.error)} onRetry={() => void accounts.refetch()} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-6">
        <div className="from-primary to-primary/70 text-primary-foreground relative overflow-hidden rounded-2xl bg-gradient-to-br p-6 shadow-sm">
          <Wallet className="absolute -right-4 -bottom-6 size-32 opacity-10" />
          <p className="text-sm font-medium opacity-80">Available balance</p>
          <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{balances.data ? inr(balances.data.available) : <Skeleton className="bg-primary-foreground/20 h-10 w-48" />}</div>
          <p className="mt-2 text-xs opacity-80">Used for payouts. Add funds by paying into a Pay2All account below, then submit the payment reference.</p>
        </div>

        {!can('fund.request') ? (
          <Card className="shadow-none">
            <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
              <Info className="size-4" /> Ask your account owner or finance team to add funds.
            </CardContent>
          </Card>
        ) : done ? (
          <Card className="shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="size-8" />
              </span>
              <div>
                <p className="text-lg font-semibold">Request submitted</p>
                <p className="text-muted-foreground text-sm">
                  {inr(done.amount)} · UTR <span className="font-mono">{done.utr}</span>. We’ll credit your wallet once the payment is verified and let you know.
                </p>
              </div>
              <Button onClick={reset}>Add more funds</Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Add funds</CardTitle>
              <CardDescription>
                <Stepper step={step} />
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {step === 0 && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="af-amount">Amount</Label>
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-xl">₹</span>
                      <Input id="af-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="0" className="h-14 pl-9 text-2xl font-semibold tabular-nums" autoFocus />
                    </div>
                    {amountError && <p className="text-destructive text-xs">{amountError}</p>}
                    <div className="flex flex-wrap gap-2">
                      {QUICK.map((q) => (
                        <button key={q} type="button" onClick={() => setAmount(q)} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', amount === q ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted')}>
                          {inr(q).replace('.00', '')}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Pay to</Label>
                    {accounts.isLoading ? (
                      <Skeleton className="h-20" />
                    ) : list.length === 0 ? (
                      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">No payment accounts are available right now. Please contact support.</p>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {list.map((a) => {
                          const on = a.id === accountId;
                          return (
                            <button key={a.id} type="button" onClick={() => choose(a)} aria-pressed={on} className={cn('flex items-start gap-3 rounded-xl border p-3 text-left transition-all', on ? 'border-primary bg-primary/5 ring-primary/20 ring-2' : 'hover:border-foreground/20')}>
                              <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', a.kind === 'UPI' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300')}>
                                {a.kind === 'UPI' ? <QrCode className="size-5" /> : <Landmark className="size-5" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold">{a.label}</span>
                                <span className="text-muted-foreground block truncate text-xs">{a.kind === 'UPI' ? `UPI · ${a.upi_id}` : `${a.bank_name} · ${a.account_number_masked}`}</span>
                                {(a.min_amount || a.max_amount) && (
                                  <span className="text-muted-foreground block text-[11px]">
                                    {a.min_amount ? `Min ${inr(a.min_amount)}` : ''}
                                    {a.min_amount && a.max_amount ? ' · ' : ''}
                                    {a.max_amount ? `Max ${inr(a.max_amount)}` : ''}
                                  </span>
                                )}
                              </span>
                              {on && <Check className="text-primary size-4 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button disabled={!canNext} onClick={() => setStep(1)}>
                      Continue <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </>
              )}

              {step === 1 && account && (
                <>
                  {account.kind === 'UPI' ? (
                    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
                      <div className="shrink-0">
                        <PaymentQr payload={upiPayload(account, amount, note)} size={220} />
                      </div>
                      <div className="w-full space-y-3">
                        <div>
                          <p className="text-muted-foreground text-xs">Pay exactly</p>
                          <p className="text-3xl font-semibold tabular-nums">{inr(amount)}</p>
                        </div>
                        <p className="text-muted-foreground text-sm">Scan with any UPI app — GPay, PhonePe, Paytm or your bank’s app. The amount is filled in.</p>
                        <div className="divide-y rounded-lg border text-left">
                          <Detail label="UPI ID" value={account.upi_id} copy mono />
                          <Detail label="Payee" value={account.payee_name} />
                        </div>
                        <Button asChild variant="outline" size="sm" className="sm:hidden">
                          <a href={upiPayload(account, amount, note)}>
                            <Smartphone className="size-4" /> Open in UPI app <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm">
                        Transfer <span className="font-semibold tabular-nums">{inr(amount)}</span> by IMPS, NEFT or RTGS to:
                      </p>
                      <div className="divide-y rounded-lg border">
                        <Detail label="Account holder" value={account.account_holder} copy />
                        <Detail label="Account number" value={account.account_number} copy mono />
                        <Detail label="IFSC" value={account.ifsc} copy mono />
                        <Detail label="Bank" value={account.bank_name} />
                        <Detail label="Branch" value={account.branch} />
                        <Detail label="Account type" value={account.account_type === 'SAVINGS' ? 'Savings' : 'Current'} />
                        <Detail label="Amount" value={amount} copy mono />
                      </div>
                    </div>
                  )}
                  {account.instructions && (
                    <p className="flex items-start gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-300">
                      <Info className="mt-0.5 size-3.5 shrink-0" /> {account.instructions}
                    </p>
                  )}
                  <div className="flex justify-between gap-2">
                    <Button variant="ghost" onClick={() => setStep(0)}>
                      <ArrowLeft className="size-4" /> Back
                    </Button>
                    <Button onClick={() => setStep(2)}>
                      I’ve paid <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </>
              )}

              {step === 2 && account && (
                <>
                  <div className="bg-muted/40 flex items-center justify-between rounded-lg px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                      {account.label} · {account.kind === 'UPI' ? account.upi_id : account.account_number_masked}
                    </span>
                    <span className="font-semibold tabular-nums">{inr(amount)}</span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="af-utr">UTR / reference number</Label>
                      <Input id="af-utr" value={utr} onChange={(e) => setUtr(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={30} placeholder={account.kind === 'UPI' ? '12-digit UPI reference, e.g. 412345678901' : 'e.g. HDFCR52026100812345678'} className="font-mono tracking-wide" />
                      <p className="text-muted-foreground text-[11px]">Find it in your UPI app’s transaction details or your bank statement.</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Paid by</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {(account.kind === 'UPI' ? (['UPI'] as const) : (['IMPS', 'NEFT', 'RTGS', 'UPI', 'CASH_DEPOSIT'] as const)).map((m) => (
                          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', mode === m ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                            {MODE_LABEL[m]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="af-when">Paid at</Label>
                      <Input id="af-when" type="datetime-local" value={paidAt} max={localNow()} onChange={(e) => setPaidAt(e.target.value)} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="af-remarks">
                        Remarks <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <Input id="af-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={300} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>
                        Payment screenshot <span className="text-muted-foreground font-normal">(optional, speeds up approval)</span>
                      </Label>
                      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => setProof(e.target.files?.[0] ?? null)} />
                      {proof ? (
                        <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <Paperclip className="size-4 shrink-0" />
                            <span className="truncate">{proof.name}</span>
                          </span>
                          <Button variant="ghost" size="icon" className="size-7" aria-label="Remove screenshot" onClick={() => setProof(null)}>
                            <X className="size-4" />
                          </Button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => fileRef.current?.click()} className="text-muted-foreground hover:border-primary/60 hover:text-foreground flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-sm transition-colors">
                          <ImageUp className="size-4" /> Attach screenshot or PDF (max 5 MB)
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-between gap-2">
                    <Button variant="ghost" onClick={() => setStep(1)}>
                      <ArrowLeft className="size-4" /> Back
                    </Button>
                    <Button disabled={busy || utr.length < 6 || !paidAt} onClick={() => void submit()}>
                      {busy && <Loader2 className="size-4 animate-spin" />} Submit for approval
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <MyRequests />
    </div>
  );
}

function MyRequests() {
  const qc = useQueryClient();
  const can = useCan();
  const list = useInfiniteQuery({
    queryKey: [...FUND_REQUESTS_KEY, 'mine'],
    queryFn: ({ pageParam }) => apiRequest<FundRequest[]>('/v1/funds/requests', { query: { limit: 20, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    refetchInterval: 30_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  async function cancel(id: string) {
    try {
      await api.post(`/v1/funds/requests/${id}/cancel`);
      toast.success('Request cancelled');
      await qc.invalidateQueries({ queryKey: FUND_REQUESTS_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card className="h-fit gap-0 overflow-hidden pt-0 shadow-none lg:sticky lg:top-4">
      <CardHeader className="border-b pt-5 [.border-b]:pb-4">
        <CardTitle className="text-base">Your requests</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {list.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">No fund requests yet.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.id} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold tabular-nums">{inr(r.credited_amount ?? r.amount)}</span>
                  <FundStatus status={r.status} />
                </div>
                <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono">
                    {MODE_LABEL[r.mode]} · {r.utr}
                  </span>
                  <span title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</span>
                </div>
                {r.credited_amount && r.credited_amount !== r.amount && <p className="text-xs text-amber-700 dark:text-amber-300">Requested {inr(r.amount)}; credited {inr(r.credited_amount)}</p>}
                {r.decision_note && <p className="text-muted-foreground text-xs">“{r.decision_note}”</p>}
                {r.status === 'PENDING' && can('fund.request') && (
                  <button type="button" onClick={() => void cancel(r.id)} className="text-muted-foreground hover:text-destructive text-xs font-medium">
                    Cancel request
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="border-t p-2 text-center">
            <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
