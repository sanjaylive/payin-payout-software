'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, FileSpreadsheet, FileUp, Info, Loader2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { StatementImportDetail, StatementImportRow } from '@/lib/api/types';
import { useFundAccounts } from './shared';

const KEY = ['fund-statements'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LINE: Record<StatementImportDetail['lines'][number]['status'], { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  MATCHED: { label: 'Matched · credited', cls: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300', icon: CheckCircle2 },
  AMOUNT_MISMATCH: { label: 'Amount differs', cls: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300', icon: TriangleAlert },
  ALREADY_DECIDED: { label: 'Already decided', cls: 'bg-muted text-muted-foreground ring-border', icon: Info },
  UNMATCHED: { label: 'No request yet', cls: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300', icon: CircleDashed },
};

/** Admin → Fund requests → Bank statements: import a statement; exact matches are credited. */
export function FundStatements() {
  const accounts = useFundAccounts();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const history = useQuery({ queryKey: KEY, queryFn: () => api.get<StatementImportRow[]>('/v1/funds/statements') });
  const detail = useQuery({ queryKey: [...KEY, open], queryFn: () => api.get<StatementImportDetail>(`/v1/funds/statements/${open}`), enabled: Boolean(open) });
  const bankAccounts = (accounts.data ?? []).filter((a) => a.kind === 'BANK');
  const selected = account || bankAccounts[0]?.id || '';

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiUpload<StatementImportDetail>(`/v1/funds/statements/${selected}`, form);
      const s = res.summary;
      toast.success(`${s.credits} credits read · ${s.matched} credited automatically${s.mismatched ? ` · ${s.mismatched} need review` : ''}`);
      setOpen(res.id);
      await Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ['fund-requests'] }), qc.invalidateQueries({ queryKey: ['fund-summary'] })]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="size-4" /> Import a bank statement
            </CardTitle>
            <CardDescription>Export the collection account&apos;s statement from your bank as CSV. Credits whose UTR and amount match a pending request exactly are credited at once.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {accounts.isLoading ? (
              <Skeleton className="h-9" />
            ) : bankAccounts.length === 0 ? (
              <p className="text-muted-foreground text-sm">Add a bank fund account first.</p>
            ) : (
              <div className="space-y-1.5">
                <Label>Fund account</Label>
                <Select value={selected} onValueChange={setAccount}>
                  <SelectTrigger aria-label="Fund account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <input ref={input} type="file" accept=".csv,text/csv" className="hidden" aria-label="Statement file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button className="w-full" disabled={!selected || busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="animate-spin" /> : <FileUp />} Choose statement CSV
            </Button>
            <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
              <li>Works with HDFC, ICICI, SBI, Axis and Kotak exports; summary rows above the table are skipped.</li>
              <li>A UTR is used once: overlapping statements never credit twice, and the same file can&apos;t be imported again.</li>
              <li>Unclaimed credits are kept; if a merchant later submits that UTR and amount, the request is credited automatically.</li>
            </ul>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden pt-0 shadow-none">
          <CardHeader className="border-b pt-4 [.border-b]:pb-3">
            <CardTitle className="text-base">Recent imports</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.isError ? (
              <div className="p-4">
                <ErrorState message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
              </div>
            ) : (history.data ?? []).length === 0 ? (
              <p className="text-muted-foreground p-6 text-center text-sm">No statements imported yet.</p>
            ) : (
              <ul className="divide-y">
                {(history.data ?? []).map((i) => (
                  <li key={i.id}>
                    <button type="button" onClick={() => setOpen(i.id)} className={cn('hover:bg-muted/40 w-full px-4 py-3 text-left', open === i.id && 'bg-muted/60')}>
                      <p className="truncate text-sm font-medium">{i.file_name}</p>
                      <p className="text-muted-foreground text-xs">
                        {i.account} · {formatRelative(i.created_at)} · {i.matched}/{i.credits} credited{i.mismatched ? ` · ${i.mismatched} to review` : ''}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-4 [.border-b]:pb-3">
          <CardTitle className="text-base">{detail.data ? detail.data.file_name : 'Statement credits'}</CardTitle>
          {detail.data && (
            <CardDescription>
              {detail.data.account} · imported {formatDateTime(detail.data.created_at)}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!open ? (
            <p className="text-muted-foreground flex flex-col items-center gap-2 p-12 text-center text-sm">
              <FileSpreadsheet className="size-7" /> Import a statement, or pick one from the list, to see each credit and how it matched.
            </p>
          ) : detail.isLoading || !detail.data ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 border-b p-4 text-xs">
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-700 dark:text-emerald-300">{detail.data.summary.matched} credited</span>
                <span className="rounded-full bg-amber-500/10 px-2.5 py-1 font-medium text-amber-700 dark:text-amber-300">{detail.data.summary.mismatched} amount differs</span>
                <span className="rounded-full bg-sky-500/10 px-2.5 py-1 font-medium text-sky-700 dark:text-sky-300">{detail.data.summary.unmatched} no request yet</span>
                <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 font-medium">{detail.data.summary.already_decided} already decided</span>
                {detail.data.summary.duplicates > 0 && <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 font-medium">{detail.data.summary.duplicates} seen in an earlier statement</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Credit</th>
                      <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-4 py-2.5 font-medium">Result</th>
                      <th className="px-4 py-2.5 font-medium">Fund request</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.data.lines.map((l) => {
                      const s = LINE[l.status];
                      return (
                        <tr key={l.id}>
                          <td className="max-w-[18rem] px-4 py-3">
                            <p className="truncate font-mono text-xs">{l.utr ?? 'No reference found'}</p>
                            <p className="text-muted-foreground truncate text-xs" title={l.description}>
                              Line {l.line_no} · {l.description || '—'}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(l.amount)}</td>
                          <td className="px-4 py-3">
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', s.cls)}>
                              <s.icon className="size-3" /> {s.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs">
                            {l.fund_request ? (
                              <Link href={`/admin/funds?request=${l.fund_request.id}`} className="hover:underline">
                                <span className="font-medium">{l.fund_request.merchant_name}</span>
                                <span className="text-muted-foreground block">
                                  asked {inr(l.fund_request.amount)} · {l.fund_request.status.toLowerCase()}
                                </span>
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
