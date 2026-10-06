'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, Loader2, Search, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { LedgerAccount, LedgerJournal, TrialBalance } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { formatMinor } from '@pay2all/ui/lib/money';
import { fmt, JOURNAL_LABELS, majorToMinor } from './format';
import { JournalDrawer } from './journal-drawer';

const ALL = '__all__';

/** Trial balance + on-demand verification (drift freezes payouts; nothing is auto-corrected). */
export function LedgerHealth() {
  const can = useCan();
  const trial = useQuery({ queryKey: ['trial-balance'], queryFn: () => api.get<TrialBalance>('/v1/ledger/trial-balance') });
  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; drift: { code: string }[]; payouts_frozen_for: string[] }>('/v1/ledger/verify'),
    onSuccess: (r) => (r.ok ? toast.success('All balances match their entries') : toast.error(`Drift on ${r.drift.length} account(s); payouts frozen for ${r.payouts_frozen_for.length} merchant(s)`)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const t = trial.data;
  return (
    <Card className="shadow-none">
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          {t?.balanced ? <CircleCheck className="text-success size-5" /> : <ShieldAlert className="text-destructive size-5" />}
          <div>
            <p className="text-sm font-semibold">{t ? (t.balanced ? 'Trial balance is zero' : `Trial balance off by ${fmt(t.difference)}`) : 'Checking…'}</p>
            <p className="text-muted-foreground text-xs">{t ? `${t.journals.toLocaleString('en-IN')} journals · ${t.entries.toLocaleString('en-IN')} entries` : ''}</p>
          </div>
        </div>
        <div className="text-sm"><span className="text-muted-foreground">Debits</span> <span className="tabular font-medium">{fmt(t?.debits)}</span></div>
        <div className="text-sm"><span className="text-muted-foreground">Credits</span> <span className="tabular font-medium">{fmt(t?.credits)}</span></div>
        {can('ledger.adjust.approve') && (
          <Button variant="outline" className="ml-auto" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending && <Loader2 className="animate-spin" />} Verify balances
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function LedgerAccountsTable() {
  const router = useRouter();
  const pager = useCursorPagination();
  const [ownerType, setOwnerType] = useState(ALL);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const accounts = useQuery({
    queryKey: ['ledger-accounts', 'admin', ownerType, submitted, pager.cursor],
    queryFn: () => api.list<LedgerAccount>('/v1/ledger/accounts', { owner_type: ownerType === ALL ? undefined : ownerType, search: submitted || undefined, cursor: pager.cursor, limit: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <DataTable
      toolbar={
        <>
          <Select value={ownerType} onValueChange={(v) => { pager.reset(); setOwnerType(v); }}>
            <SelectTrigger className="w-44" aria-label="Owner type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All owners</SelectItem>
              <SelectItem value="PLATFORM">Platform</SelectItem>
              <SelectItem value="MERCHANT">Merchants</SelectItem>
              <SelectItem value="RESELLER">Resellers</SelectItem>
            </SelectContent>
          </Select>
          <form className="relative w-full max-w-sm" onSubmit={(e) => { e.preventDefault(); pager.reset(); setSubmitted(search.trim()); }}>
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input className="pl-8" placeholder="Account code or merchant id" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search accounts" />
          </form>
        </>
      }
      rows={accounts.data?.data}
      loading={accounts.isFetching}
      error={toTableError(accounts.error)}
      rowKey={(a) => a.id}
      onRowClick={(a) => router.push(`/admin/ledger/accounts/${a.id}`)}
      empty={{ title: 'No accounts' }}
      pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(accounts.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(accounts.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
      columns={[
        { id: 'name', header: 'Account', cell: (a) => <div><p className="font-medium">{a.name}</p><p className="text-muted-foreground font-mono text-[11px]">{a.code}</p></div> },
        { id: 'type', header: 'Type', cell: (a) => <StatusBadge status={a.type} tone="neutral" /> },
        { id: 'normal', header: 'Normal', cell: (a) => <span className="text-xs">{a.normal_balance}</span> },
        { id: 'balance', header: 'Balance', align: 'right', cell: (a) => (a.maintained ? <span className="tabular font-medium">{fmt(a.balance)}</span> : <span className="text-muted-foreground text-xs">aggregated</span>) },
      ]}
    />
  );
}

const JOURNAL_TYPES = Object.keys(JOURNAL_LABELS);

export function JournalsTable({ merchantId }: { merchantId?: string }) {
  const pager = useCursorPagination();
  const [type, setType] = useState(ALL);
  const [source, setSource] = useState('');
  const [submittedSource, setSubmittedSource] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const journals = useQuery({
    queryKey: ['journals', merchantId, type, submittedSource, pager.cursor],
    queryFn: () => api.list<LedgerJournal>('/v1/ledger/journals', { merchant_id: merchantId, type: type === ALL ? undefined : type, source_id: submittedSource || undefined, cursor: pager.cursor, limit: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        toolbar={
          <>
            <Select value={type} onValueChange={(v) => { pager.reset(); setType(v); }}>
              <SelectTrigger className="w-56" aria-label="Journal type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All journal types</SelectItem>
                {JOURNAL_TYPES.map((t) => <SelectItem key={t} value={t}>{JOURNAL_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
            <form className="relative w-full max-w-xs" onSubmit={(e) => { e.preventDefault(); pager.reset(); setSubmittedSource(source.trim()); }}>
              <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
              <Input className="pl-8" placeholder="Source id (pay_…, pout_…)" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source id" />
            </form>
          </>
        }
        rows={journals.data?.data}
        loading={journals.isFetching}
        error={toTableError(journals.error)}
        rowKey={(j) => j.id}
        onRowClick={(j) => setOpen(j.id)}
        empty={{ title: 'No journals' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(journals.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(journals.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'posted', header: 'Posted', cell: (j) => <span className="text-sm whitespace-nowrap">{formatDateTime(j.posted_at)}</span> },
          { id: 'type', header: 'Type', cell: (j) => <div className="flex items-center gap-2"><span className="text-sm font-medium">{JOURNAL_LABELS[j.type] ?? j.type}</span>{j.reversed_by_journal_id && <StatusBadge status="REVERSED" />}</div> },
          { id: 'source', header: 'Source', cell: (j) => <span className="font-mono text-xs">{j.source_type} · {j.source_id}</span> },
          { id: 'amount', header: 'Amount', align: 'right', cell: (j) => <span className="tabular">{formatMinor(j.entries.filter((e) => e.direction === 'DEBIT').reduce((sum, e) => sum + majorToMinor(e.amount), 0n))}</span> },
        ]}
      />
      <JournalDrawer journalId={open} onClose={() => setOpen(null)} onOpenJournal={setOpen} />
    </>
  );
}
