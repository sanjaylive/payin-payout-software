'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { ActivityTimeline } from '@pay2all/ui/components/timeline';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { Organization, SalesLead } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

interface LeadForm {
  company_name: string;
  contact_name: string;
  contact_email: string;
  contact_mobile: string;
  source: string;
  expected_monthly_volume: string;
  follow_up_date: string;
  notes: string;
}

function NewLeadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<LeadForm>({ defaultValues: { company_name: '', contact_name: '', contact_email: '', contact_mobile: '', source: '', expected_monthly_volume: '', follow_up_date: '', notes: '' } });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/v1/sales/leads', Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')));
      toast.success('Lead created');
      form.reset();
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) for (const d of e.details) form.setError(d.path as keyof LeadForm, { message: d.message });
      else setError(e);
    }
  });
  const err = (k: keyof LeadForm) => form.formState.errors[k]?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New lead</DialogTitle></DialogHeader>
        <FormError error={error} />
        <form id="lead-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <FormField label="Company" error={err('company_name')} {...form.register('company_name')} />
          <FormField label="Contact name" error={err('contact_name')} {...form.register('contact_name')} />
          <FormField label="Email" type="email" error={err('contact_email')} {...form.register('contact_email')} />
          <FormField label="Mobile" error={err('contact_mobile')} {...form.register('contact_mobile')} />
          <FormField label="Source" placeholder="website, referral, event…" error={err('source')} {...form.register('source')} />
          <FormField label="Expected monthly volume" placeholder="₹25 lakh" {...form.register('expected_monthly_volume')} />
          <FormField label="Follow-up date" type="date" error={err('follow_up_date')} {...form.register('follow_up_date')} />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="lead-notes">Notes</Label>
            <Textarea id="lead-notes" rows={3} {...form.register('notes')} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="lead-form" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <Loader2 className="animate-spin" />} Create lead</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadDrawer({ lead, onClose }: { lead: SalesLead | null; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [reseller, setReseller] = useState('none');
  const [busy, setBusy] = useState(false);
  const resellers = useQuery({ queryKey: ['organizations', 'RESELLER', 'options'], queryFn: () => api.list<Organization>('/v1/organizations', { type: 'RESELLER', status: 'ACTIVE', limit: 100 }), enabled: Boolean(lead) });

  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const open = Boolean(lead);
  const editable = lead && lead.status !== 'CONVERTED' && can('sales.manage');
  return (
    <TransactionDetailsDrawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={lead?.company_name}
      subtitle={lead && <StatusBadge status={lead.status} />}
      sections={
        lead
          ? [{ title: 'Contact', fields: [
              { label: 'Name', value: lead.contact_name },
              { label: 'Email', value: lead.contact_email ?? '—' },
              { label: 'Mobile', value: lead.contact_mobile ?? '—' },
              { label: 'Source', value: lead.source },
              { label: 'Volume', value: lead.expected_monthly_volume ?? '—' },
              { label: 'Follow up', value: lead.follow_up_date ?? '—' },
            ] }]
          : []
      }
    >
      {lead && (
        <div className="space-y-6">
          {editable && (
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={lead.status} onValueChange={(v) => void run(() => api.patch(`/v1/sales/leads/${lead.id}`, { status: v }), 'Status updated').then(onClose)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{['NEW', 'CONTACTED', 'QUALIFIED', 'LOST'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <section className="space-y-3">
            <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Notes</h4>
            <ActivityTimeline items={lead.notes.map((n, i) => ({ id: String(i), title: n.text, timestamp: n.at }))} />
            {editable && (
              <div className="flex gap-2">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" aria-label="New note" />
                <Button variant="outline" disabled={busy || note.trim().length < 2} onClick={() => void run(() => api.patch(`/v1/sales/leads/${lead.id}`, { note }), 'Note added').then(() => { setNote(''); onClose(); })}>Add</Button>
              </div>
            )}
          </section>
          {editable && can('merchant.create') && (
            <section className="space-y-2 rounded-lg border p-3">
              <h4 className="text-sm font-semibold">Convert to merchant</h4>
              <p className="text-muted-foreground text-xs">Creates a draft merchant application owned by this lead&apos;s salesperson.</p>
              <Select value={reseller} onValueChange={setReseller}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Direct (Pay2All)</SelectItem>
                  {resellers.data?.data.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const res = await api.post<{ merchant_id: string }>(`/v1/sales/leads/${lead.id}/convert`, reseller === 'none' ? {} : { reseller_id: reseller });
                    router.push(`/admin/merchants/${res.merchant_id}`);
                  }, 'Merchant created from lead')
                }
              >
                <ArrowRightLeft /> Convert
              </Button>
            </section>
          )}
          {lead.converted_merchant_id && (
            <Button variant="outline" onClick={() => router.push(`/admin/merchants/${lead.converted_merchant_id}`)}>Open merchant</Button>
          )}
        </div>
      )}
    </TransactionDetailsDrawer>
  );
}

export function SalesLeads() {
  const can = useCan();
  const pager = useCursorPagination();
  const [status, setStatus] = useState('ALL');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<SalesLead | null>(null);
  const leads = useQuery({
    queryKey: ['leads', status, mine, pager.cursor],
    queryFn: () => api.list<SalesLead>('/v1/sales/leads', { status: status === 'ALL' ? undefined : status, assigned_to: mine ? 'me' : undefined, cursor: pager.cursor, limit: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        toolbar={
          <>
            <Tabs value={status} onValueChange={(v) => { pager.reset(); setStatus(v); }}>
              <TabsList>{['ALL', 'NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'].map((s) => <TabsTrigger key={s} value={s}>{s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase()}</TabsTrigger>)}</TabsList>
            </Tabs>
            <Button variant={mine ? 'secondary' : 'ghost'} size="sm" onClick={() => { pager.reset(); setMine(!mine); }}>My leads</Button>
            {can('sales.manage') && <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New lead</Button>}
          </>
        }
        rows={leads.data?.data}
        loading={leads.isFetching}
        error={toTableError(leads.error)}
        rowKey={(l) => l.id}
        onRowClick={setSelected}
        empty={{ title: 'No leads' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(leads.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(leads.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'company', header: 'Company', cell: (l) => <div><p className="font-medium">{l.company_name}</p><p className="text-muted-foreground text-xs">{l.contact_name}</p></div> },
          { id: 'source', header: 'Source', cell: (l) => l.source },
          { id: 'volume', header: 'Volume', cell: (l) => l.expected_monthly_volume ?? '—' },
          { id: 'status', header: 'Status', cell: (l) => <StatusBadge status={l.status} /> },
          { id: 'follow', header: 'Follow up', cell: (l) => <span className={l.follow_up_date && l.follow_up_date < new Date().toISOString().slice(0, 10) && l.status !== 'CONVERTED' ? 'text-destructive font-medium' : ''}>{l.follow_up_date ?? '—'}</span> },
        ]}
      />
      <NewLeadDialog open={creating} onOpenChange={setCreating} />
      <LeadDrawer key={selected?.id} lead={selected} onClose={() => setSelected(null)} />
    </>
  );
}
