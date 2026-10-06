'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt, majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';

interface Row {
  reseller_id: string;
  name: string;
  payable_balance: string;
}

function PayoutDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{1,10}(\.\d{1,2})?$/.test(amount) && /^[A-Za-z0-9]{6,40}$/.test(utr) && row !== null && majorToMinor(amount) > 0n && majorToMinor(amount) <= majorToMinor(row.payable_balance);
  async function submit() {
    if (!row) return;
    setBusy(true);
    try {
      await api.post(`/v1/resellers/${row.reseller_id}/commission-payouts`, { amount: amount.includes('.') ? amount : `${amount}.00`, utr, ...(note.trim() ? { period_note: note.trim() } : {}) });
      toast.success('Commission payout recorded');
      await qc.invalidateQueries({ queryKey: ['commission-overview'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(row)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record commission payout</DialogTitle>
          <DialogDescription>{row?.name}: {fmt(row?.payable_balance)} payable. Record the bank transfer you made; this posts Dr commission payable / Cr bank.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="cp-amt">Amount (₹)</Label><Input id="cp-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="cp-utr">UTR</Label><Input id="cp-utr" className="font-mono" value={utr} onChange={(e) => setUtr(e.target.value.trim())} /></div>
          <div className="space-y-1.5"><Label htmlFor="cp-note">Period (optional)</Label><Input id="cp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. October 2026" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Record payout</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminCommissions() {
  const can = useCan();
  const q = useQuery({ queryKey: ['commission-overview'], queryFn: () => api.get<Row[]>('/v1/resellers/commissions'), enabled: can('ledger.platform.read') });
  const [paying, setPaying] = useState<Row | null>(null);
  if (!can('ledger.platform.read')) return null;
  return (
    <>
      <DataTable
        rows={q.data}
        loading={q.isFetching}
        error={toTableError(q.error)}
        rowKey={(r) => r.reseller_id}
        empty={{ title: 'No resellers' }}
        columns={[
          { id: 'name', header: 'Reseller', cell: (r) => <span className="font-medium">{r.name}</span> },
          { id: 'bal', header: 'Commission payable', align: 'right', cell: (r) => <span className="tabular font-medium">{fmt(r.payable_balance)}</span> },
          { id: 'act', header: '', align: 'right', cell: (r) => (can('settlement.process') && r.payable_balance !== '0.00' ? <Button size="sm" variant="outline" onClick={() => setPaying(r)}><Landmark /> Record payout</Button> : null) },
        ]}
      />
      <PayoutDialog key={paying?.reseller_id ?? 'none'} row={paying} onClose={() => setPaying(null)} />
    </>
  );
}
