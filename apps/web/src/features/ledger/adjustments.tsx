'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { LedgerAdjustment } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { fmt } from './format';

function NewAdjustmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ merchant_id: '', direction: 'CREDIT', amount: '', reason: '', reference: '', supporting_note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });

  async function submit() {
    setBusy(true);
    setErrors({});
    try {
      await api.post('/v1/ledger/adjustments', { ...form, supporting_note: form.supporting_note || undefined });
      toast.success('Adjustment raised — awaiting an independent approver');
      onOpenChange(false);
      setForm({ merchant_id: '', direction: 'CREDIT', amount: '', reason: '', reference: '', supporting_note: '' });
      await qc.invalidateQueries({ queryKey: ['adjustments'] });
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New manual adjustment</DialogTitle>
          <DialogDescription>Balances are never edited directly. This raises a request that a different person must approve; only then is a balanced journal posted.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Merchant</Label>
            <MerchantCombobox value={form.merchant_id || null} onChange={(m) => set('merchant_id')(m?.id ?? '')} status="APPROVED,SUSPENDED" />
          </div>
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <Select value={form.direction} onValueChange={set('direction')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="CREDIT">Credit (add to available)</SelectItem><SelectItem value="DEBIT">Debit (deduct from available)</SelectItem></SelectContent>
            </Select>
          </div>
          <FormField label="Amount (₹)" name="amount" inputMode="decimal" value={form.amount} error={errors.amount} onChange={(e) => set('amount')(e.target.value)} />
          <FormField label="Reference" name="reference" placeholder="Ticket / recon id" value={form.reference} error={errors.reference} onChange={(e) => set('reference')(e.target.value)} />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="adj-reason">Reason</Label>
            <Textarea id="adj-reason" rows={2} value={form.reason} onChange={(e) => set('reason')(e.target.value)} />
            {errors.reason && <p className="text-destructive text-xs">{errors.reason}</p>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="adj-note">Supporting note (optional)</Label>
            <Textarea id="adj-note" rows={2} value={form.supporting_note} onChange={(e) => set('supporting_note')(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !form.merchant_id} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Raise adjustment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustmentsConsole() {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const pager = useCursorPagination();
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<LedgerAdjustment | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ['adjustments', status, pager.cursor],
    queryFn: () => api.list<LedgerAdjustment>('/v1/ledger/adjustments', { status: status === 'ALL' ? undefined : status, cursor: pager.cursor, limit: 25 }),
    placeholderData: keepPreviousData,
  });

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      setRejecting(null);
      await qc.invalidateQueries({ queryKey: ['adjustments'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DataTable
        toolbar={
          <>
            <Tabs value={status} onValueChange={(v) => { pager.reset(); setStatus(v); }}>
              <TabsList>
                <TabsTrigger value="PENDING_APPROVAL">Pending approval</TabsTrigger>
                <TabsTrigger value="POSTED">Posted</TabsTrigger>
                <TabsTrigger value="REJECTED">Rejected</TabsTrigger>
                <TabsTrigger value="ALL">All</TabsTrigger>
              </TabsList>
            </Tabs>
            {can('ledger.adjust') && <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New adjustment</Button>}
          </>
        }
        rows={list.data?.data}
        loading={list.isFetching}
        error={toTableError(list.error)}
        rowKey={(a) => a.id}
        empty={{ title: 'No adjustments' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(list.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(list.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'created', header: 'Raised', cell: (a) => <span className="text-sm whitespace-nowrap">{formatDateTime(a.created_at)}</span> },
          { id: 'merchant', header: 'Merchant', cell: (a) => <span className="font-mono text-xs">{a.merchant_id}</span> },
          { id: 'reason', header: 'Reason', cell: (a) => <div className="max-w-xs"><p className="truncate text-sm">{a.reason}</p><p className="text-muted-foreground text-xs">{a.reference}</p></div> },
          { id: 'amount', header: 'Amount', align: 'right', cell: (a) => <span className={`tabular font-medium ${a.direction === 'CREDIT' ? 'text-success' : 'text-destructive'}`}>{a.direction === 'CREDIT' ? '+' : '−'}{fmt(a.amount)}</span> },
          { id: 'status', header: 'Status', cell: (a) => <div className="space-y-0.5"><StatusBadge status={a.status} />{a.status === 'PENDING_APPROVAL' && <p className="text-muted-foreground text-xs">{a.approvals.length}/{a.approvals_required} approvals</p>}</div> },
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (a) =>
              a.status === 'PENDING_APPROVAL' ? (
                <div className="flex justify-end gap-1">
                  {can('ledger.adjust.approve') && a.maker_id !== me?.user.id && !a.approvals.some((x) => x.approver_id === me?.user.id) && (
                    <Button size="sm" disabled={busy} onClick={() => void act(() => api.post(`/v1/ledger/adjustments/${a.id}/approve`, {}), 'Approved')}><Check /> Approve</Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(a)}><X /> {a.maker_id === me?.user.id ? 'Cancel' : 'Reject'}</Button>
                </div>
              ) : null,
          },
        ]}
      />
      <NewAdjustmentDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={rejecting?.maker_id === me?.user.id ? 'Cancel adjustment?' : 'Reject adjustment?'}
        description="No journal will be posted."
        destructive
        requireReason
        pending={busy}
        onConfirm={(reason) => rejecting && void act(() => api.post(`/v1/ledger/adjustments/${rejecting.id}/reject`, { reason }), 'Done')}
      />
    </>
  );
}
