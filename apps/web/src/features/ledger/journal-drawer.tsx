'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LedgerJournal } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { fmt, JOURNAL_LABELS } from './format';

/** Journal detail: balanced lines, provenance, and (for authorised staff) a one-time reversal. */
export function JournalDrawer({ journalId, onClose, onOpenJournal }: { journalId: string | null; onClose: () => void; onOpenJournal?: (id: string) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const journal = useQuery({ queryKey: ['journal', journalId], queryFn: () => api.get<LedgerJournal>(`/v1/ledger/journals/${journalId}`), enabled: Boolean(journalId) });
  const j = journal.data;
  const canReverse = j && can('ledger.adjust.approve') && j.type !== 'REVERSAL' && !j.reversed_by_journal_id;

  async function reverse(reason?: string) {
    if (!j) return;
    setBusy(true);
    try {
      const rev = await api.post<LedgerJournal>(`/v1/ledger/journals/${j.id}/reverse`, { reason });
      toast.success('Reversal posted');
      setConfirming(false);
      await qc.invalidateQueries();
      onOpenJournal?.(rev.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TransactionDetailsDrawer
      open={Boolean(journalId)}
      onOpenChange={(o) => !o && onClose()}
      title={j ? JOURNAL_LABELS[j.type] ?? j.type : 'Journal'}
      subtitle={j && <span className="font-mono text-xs">{j.id}</span>}
      sections={
        j
          ? [
              {
                title: 'Journal',
                fields: [
                  { label: 'Type', value: j.type, mono: true },
                  { label: 'Source', value: `${j.source_type} · ${j.source_id}`, mono: true },
                  { label: 'Posted', value: formatDateTime(j.posted_at) },
                  { label: 'Effective', value: formatDateTime(j.effective_at) },
                  ...(j.description ? [{ label: 'Description', value: j.description }] : []),
                  ...(j.idempotency_key ? [{ label: 'Idempotency key', value: j.idempotency_key, mono: true }] : []),
                  ...(j.request_id ? [{ label: 'Request ID', value: j.request_id, mono: true }] : []),
                ],
              },
            ]
          : []
      }
    >
      {j && (
        <div className="space-y-4">
          {j.reverses_journal_id && (
            <p className="text-sm">
              Reverses <button className="text-primary font-mono text-xs hover:underline" onClick={() => onOpenJournal?.(j.reverses_journal_id!)}>{j.reverses_journal_id}</button>
            </p>
          )}
          {j.reversed_by_journal_id && (
            <p className="flex items-center gap-2 text-sm">
              <StatusBadge status="REVERSED" /> by <button className="text-primary font-mono text-xs hover:underline" onClick={() => onOpenJournal?.(j.reversed_by_journal_id!)}>{j.reversed_by_journal_id}</button>
            </p>
          )}
          <section>
            <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Entries</h4>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Account</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {j.entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <p className="text-sm">{e.account_name}</p>
                        <p className="text-muted-foreground font-mono text-[11px]">{e.account_code}</p>
                      </TableCell>
                      <TableCell className="tabular text-right">{e.direction === 'DEBIT' ? fmt(e.amount) : ''}</TableCell>
                      <TableCell className="tabular text-right">{e.direction === 'CREDIT' ? fmt(e.amount) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
          {canReverse && (
            <Button variant="outline" onClick={() => setConfirming(true)}><Undo2 /> Reverse journal</Button>
          )}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Post a reversal?"
            description="An exact mirror journal is posted. Use this only to correct a wrong posting — refunds, chargebacks and payout returns have their own flows. A journal can be reversed once."
            confirmLabel="Post reversal"
            destructive
            requireReason
            pending={busy}
            onConfirm={(reason) => void reverse(reason)}
          />
        </div>
      )}
    </TransactionDetailsDrawer>
  );
}
