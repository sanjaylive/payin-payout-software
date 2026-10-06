'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { LedgerAccount, StatementEntry } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { BUCKET_LABELS, fmt, JOURNAL_LABELS } from './format';
import { JournalDrawer } from './journal-drawer';

/** Signed amount from the account holder's perspective (credit-normal: credits increase). */
function signed(entry: StatementEntry, normal: 'DEBIT' | 'CREDIT') {
  const increase = entry.direction === normal;
  return <span className={cn('tabular font-medium', increase ? 'text-success' : 'text-foreground')}>{increase ? '+' : '−'}{fmt(entry.amount)}</span>;
}

export function AccountStatement({ account }: { account: LedgerAccount }) {
  const pager = useCursorPagination();
  const [journalId, setJournalId] = useState<string | null>(null);
  const entries = useQuery({
    queryKey: ['statement', account.id, pager.cursor],
    queryFn: () => api.list<StatementEntry>(`/v1/ledger/accounts/${account.id}/entries`, { cursor: pager.cursor, limit: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        rows={entries.data?.data}
        loading={entries.isFetching}
        error={toTableError(entries.error)}
        rowKey={(e) => e.id}
        onRowClick={(e) => setJournalId(e.journal_id)}
        empty={{ title: 'No entries yet' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(entries.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(entries.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'time', header: 'Date', cell: (e) => <span className="text-sm whitespace-nowrap">{formatDateTime(e.created_at)}</span> },
          { id: 'what', header: 'Description', cell: (e) => <div><p className="text-sm font-medium">{JOURNAL_LABELS[e.journal_type] ?? e.journal_type}</p><p className="text-muted-foreground text-xs">{e.description ?? e.source_id}</p></div> },
          { id: 'ref', header: 'Reference', cell: (e) => <span className="font-mono text-xs">{e.source_id}</span> },
          { id: 'amount', header: 'Amount', align: 'right', cell: (e) => signed(e, account.normal_balance) },
          { id: 'balance', header: 'Balance', align: 'right', cell: (e) => <span className="tabular text-sm">{fmt(e.balance_after)}</span> },
        ]}
      />
      <JournalDrawer journalId={journalId} onClose={() => setJournalId(null)} onOpenJournal={setJournalId} />
    </>
  );
}

/** Merchant statement with a bucket switcher (Available, Unsettled, …). */
export function MerchantStatement({ merchantId }: { merchantId: string }) {
  const accounts = useQuery({ queryKey: ['ledger-accounts', merchantId], queryFn: () => api.list<LedgerAccount>('/v1/ledger/accounts', { owner_id: merchantId, limit: 20 }) });
  const list = (accounts.data?.data ?? []).sort((a, b) => Object.keys(BUCKET_LABELS).indexOf(a.bucket ?? '') - Object.keys(BUCKET_LABELS).indexOf(b.bucket ?? ''));
  const [selected, setSelected] = useState<string | null>(null);
  const active = list.find((a) => a.id === selected) ?? list.find((a) => a.bucket === 'AVAILABLE') ?? list[0];
  if (accounts.isPending) return null;
  if (!active) return <DataTable rows={[]} rowKey={() => ''} columns={[]} empty={{ title: 'No ledger activity yet', description: 'Entries appear here once payments are collected.' }} />;
  return (
    <div className="space-y-4">
      <Tabs value={active.id} onValueChange={setSelected}>
        <TabsList className="flex-wrap">
          {list.map((a) => (
            <TabsTrigger key={a.id} value={a.id}>{BUCKET_LABELS[a.bucket ?? ''] ?? a.name} · {fmt(a.balance)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <AccountStatement key={active.id} account={active} />
    </div>
  );
}
