'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { beneficiaryFormSchema } from '@pay2all/validation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Ban, Loader2, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { Beneficiary } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { statusLabel } from './labels';

type FormValues = z.input<typeof beneficiaryFormSchema>;

export const destination = (b: Pick<Beneficiary, 'upi_id' | 'account_number_masked' | 'ifsc' | 'bank_name'>) => b.upi_id ?? `${b.account_number_masked} · ${b.ifsc}${b.bank_name ? ` · ${b.bank_name}` : ''}`;

/** Add-beneficiary dialog. The account number is typed twice and sent once; it is never shown again. */
export function AddBeneficiaryDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (b: Beneficiary) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(beneficiaryFormSchema), defaultValues: { name: '', type: 'INDIVIDUAL', destination: 'ACCOUNT', account_number: '', confirm_account_number: '', ifsc: '', upi_id: '' } });
  const dest = useWatch({ control: form.control, name: 'destination' });
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const b = await api.post<Beneficiary>('/v1/beneficiaries', { name: v.name, type: v.type, ...(v.destination === 'ACCOUNT' ? { account_number: v.account_number, ifsc: v.ifsc.toUpperCase() } : { upi_id: v.upi_id }) });
      toast.success(`${b.name} added`);
      await qc.invalidateQueries({ queryKey: ['beneficiaries'] });
      form.reset();
      onOpenChange(false);
      onCreated?.(b);
    } catch (err) {
      setError(err);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add beneficiary</DialogTitle>
          <DialogDescription>Account numbers are stored encrypted and shown masked from now on.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
          <FormError error={error} />
          <FormField label="Name as per bank" autoComplete="off" error={e.name?.message} {...form.register('name')} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ben-type">Type</Label>
              <Controller control={form.control} name="type" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="ben-type" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INDIVIDUAL">Individual</SelectItem><SelectItem value="BUSINESS">Business</SelectItem></SelectContent></Select>
              )} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ben-dest">Pay to</Label>
              <Controller control={form.control} name="destination" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="ben-dest" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ACCOUNT">Bank account</SelectItem><SelectItem value="UPI">UPI ID</SelectItem></SelectContent></Select>
              )} />
            </div>
          </div>
          {dest === 'ACCOUNT' ? (
            <>
              <FormField label="Account number" inputMode="numeric" autoComplete="off" error={e.account_number?.message} {...form.register('account_number')} />
              <FormField label="Confirm account number" inputMode="numeric" autoComplete="off" onPaste={(ev) => ev.preventDefault()} error={e.confirm_account_number?.message} {...form.register('confirm_account_number')} />
              <FormField label="IFSC" autoComplete="off" className="uppercase" error={e.ifsc?.message} {...form.register('ifsc')} />
            </>
          ) : (
            <FormField label="UPI ID" placeholder="name@bank" autoComplete="off" error={e.upi_id?.message} {...form.register('upi_id')} />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <Loader2 className="animate-spin" />} Add beneficiary</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BeneficiariesTable() {
  const can = useCan();
  const qc = useQueryClient();
  const pager = useCursorPagination();
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [blocking, setBlocking] = useState<Beneficiary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = { limit: 25, cursor: pager.cursor, status: status === 'ALL' ? undefined : status, search: search.trim() || undefined };
  const list = useQuery({ queryKey: ['beneficiaries', query], queryFn: () => api.list<Beneficiary>('/v1/beneficiaries', query), placeholderData: keepPreviousData });
  const manage = can('beneficiary.manage');

  async function verify(b: Beneficiary) {
    setBusy(b.beneficiary_id);
    try {
      const r = await api.post<Beneficiary>(`/v1/beneficiaries/${b.beneficiary_id}/verify`);
      if (r.verification_status === 'VERIFIED') toast.success(`Verified — bank name "${r.verified_name}"`);
      else toast.error(r.verification_failure ?? 'Verification failed');
      await qc.invalidateQueries({ queryKey: ['beneficiaries'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function block(reason?: string) {
    if (!blocking) return;
    setBusy(blocking.beneficiary_id);
    try {
      await api.post(`/v1/beneficiaries/${blocking.beneficiary_id}/block`, { reason });
      toast.success('Beneficiary blocked');
      setBlocking(null);
      await qc.invalidateQueries({ queryKey: ['beneficiaries'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DataTable
        rows={list.data?.data}
        loading={list.isFetching}
        error={toTableError(list.error)}
        rowKey={(b) => b.beneficiary_id}
        empty={{ title: 'No beneficiaries yet', description: 'Add one here, or they are saved automatically when you pay a new account.', action: manage ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add beneficiary</Button> : undefined }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(list.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(list.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input className="pl-8" placeholder="Name, UPI ID or last 4 digits" value={search} onChange={(e) => { setSearch(e.target.value); pager.reset(); }} aria-label="Search beneficiaries" />
              </div>
              <Select value={status} onValueChange={(v) => { setStatus(v); pager.reset(); }}>
                <SelectTrigger className="w-40" aria-label="Verification"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  {['PENDING', 'VERIFIED', 'FAILED', 'BLOCKED'].map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {manage && <Button onClick={() => setAdding(true)}><Plus /> Add beneficiary</Button>}
          </div>
        }
        columns={[
          { id: 'name', header: 'Beneficiary', cell: (b) => <div><p className="font-medium">{b.name}</p><p className="text-muted-foreground text-xs">{b.type === 'BUSINESS' ? 'Business' : 'Individual'} · added {formatDateTime(b.created_at)}</p></div> },
          { id: 'dest', header: 'Destination', cell: (b) => <span className="font-mono text-xs">{destination(b)}</span> },
          {
            id: 'status',
            header: 'Verification',
            cell: (b) => (
              <div className="space-y-0.5">
                <StatusBadge status={b.verification_status} />
                {b.verified_name && <p className="text-muted-foreground text-[11px]">Bank name: {b.verified_name}{b.name_match_score !== null ? ` (${b.name_match_score}% match)` : ''}</p>}
                {b.verification_failure && <p className="text-destructive text-[11px]">{b.verification_failure}</p>}
                {b.blocked_reason && <p className="text-muted-foreground text-[11px]">{b.blocked_reason}</p>}
              </div>
            ),
          },
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (b) =>
              manage && b.verification_status !== 'BLOCKED' ? (
                <div className="flex justify-end gap-1">
                  {b.verification_status !== 'VERIFIED' && <Button size="sm" variant="outline" disabled={busy === b.beneficiary_id} onClick={() => void verify(b)}>{busy === b.beneficiary_id ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Verify</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setBlocking(b)} aria-label={`Block ${b.name}`}><Ban /></Button>
                </div>
              ) : null,
          },
        ]}
      />
      <AddBeneficiaryDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={Boolean(blocking)}
        onOpenChange={(o) => !o && setBlocking(null)}
        title={`Block ${blocking?.name ?? 'beneficiary'}?`}
        description="Blocked beneficiaries can't receive payouts. Payouts already sent are not affected."
        confirmLabel="Block"
        destructive
        requireReason
        pending={busy !== null}
        onConfirm={(reason) => void block(reason)}
      />
    </>
  );
}
