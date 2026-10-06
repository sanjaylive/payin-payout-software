'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { MerchantApplication, MerchantSummary, Organization } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { ENTITY_LABELS, PENDING_REVIEW_STATUSES } from './labels';

export const STATUS_TABS: { id: string; label: string; statuses?: string[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending review', statuses: PENDING_REVIEW_STATUSES },
  { id: 'draft', label: 'Draft', statuses: ['DRAFT'] },
  { id: 'approved', label: 'Approved', statuses: ['APPROVED'] },
  { id: 'suspended', label: 'Suspended', statuses: ['SUSPENDED'] },
  { id: 'rejected', label: 'Rejected', statuses: ['REJECTED'] },
];

function CreateMerchantDialog({ open, onOpenChange, detailBase }: { open: boolean; onOpenChange: (o: boolean) => void; detailBase: string }) {
  const { data: me } = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [reseller, setReseller] = useState('none');
  const [busy, setBusy] = useState(false);
  const isPlatform = me?.organization.type === 'PLATFORM';
  const resellers = useQuery({
    queryKey: ['organizations', 'RESELLER', 'options'],
    queryFn: () => api.list<Organization>('/v1/organizations', { type: 'RESELLER', status: 'ACTIVE', limit: 100 }),
    enabled: open && isPlatform,
  });

  async function create() {
    setBusy(true);
    try {
      const m = await api.post<MerchantApplication>('/v1/merchants', { display_name: name.trim(), ...(isPlatform && reseller !== 'none' ? { reseller_id: reseller } : {}) });
      toast.success(`${m.name} created`);
      onOpenChange(false);
      setName('');
      await qc.invalidateQueries({ queryKey: ['merchants'] });
      router.push(`${detailBase}/${m.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New merchant</DialogTitle>
          <DialogDescription>Creates a draft application. Invite the merchant&apos;s owner from its Team page, or complete onboarding on their behalf.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Business display name" name="display_name" value={name} onChange={(e) => setName(e.target.value)} />
          {isPlatform && (
            <div className="space-y-1.5">
              <Label htmlFor="reseller">Reseller</Label>
              <Select value={reseller} onValueChange={setReseller}>
                <SelectTrigger id="reseller" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Direct (Pay2All)</SelectItem>
                  {resellers.data?.data.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || name.trim().length < 2} onClick={() => void create()}>{busy && <Loader2 className="animate-spin" />} Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Server-paginated merchant list with status tabs; rows open the merchant detail page. */
export function MerchantsTable({ detailBase, defaultTab = 'all', hideTabs }: { detailBase: string; defaultTab?: string; hideTabs?: boolean }) {
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const pager = useCursorPagination();
  const tabFromUrl = params.get('status') === 'SUSPENDED' ? 'suspended' : params.get('tab');
  const [tab, setTab] = useState(tabFromUrl ?? defaultTab);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [creating, setCreating] = useState(false);
  const statuses = STATUS_TABS.find((t) => t.id === tab)?.statuses;

  const merchants = useQuery({
    queryKey: ['merchants', tab, pager.cursor, submitted],
    queryFn: () => api.list<MerchantSummary>('/v1/merchants', { status: statuses?.join(','), cursor: pager.cursor, limit: 25, search: submitted || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <DataTable
        toolbar={
          <>
            {!hideTabs && (
              <Tabs value={tab} onValueChange={(v) => { pager.reset(); setTab(v); }}>
                <TabsList>{STATUS_TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList>
              </Tabs>
            )}
            <form className="relative w-full max-w-xs" onSubmit={(e) => { e.preventDefault(); pager.reset(); setSubmitted(search.trim()); }}>
              <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, ID, PAN or GSTIN" className="pl-8" aria-label="Search merchants" />
            </form>
            {can('merchant.create') && <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New merchant</Button>}
          </>
        }
        rows={merchants.data?.data}
        loading={merchants.isFetching}
        error={toTableError(merchants.error)}
        onRetry={() => void merchants.refetch()}
        rowKey={(m) => m.id}
        onRowClick={(m) => router.push(`${detailBase}/${m.id}`)}
        empty={{ title: 'No merchants found' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(merchants.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(merchants.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'name', header: 'Merchant', cell: (m) => <div><p className="font-medium">{m.name}</p><p className="text-muted-foreground text-xs">{m.legal_name ?? m.id}</p></div> },
          { id: 'entity', header: 'Entity', cell: (m) => <span className="text-sm">{m.entity_type ? ENTITY_LABELS[m.entity_type]?.split(' (')[0] : '—'}</span> },
          { id: 'reseller', header: 'Reseller', cell: (m) => <span className="text-sm">{m.reseller?.name ?? 'Direct'}</span> },
          { id: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
          { id: 'risk', header: 'Risk', cell: (m) => (m.risk_category ? <StatusBadge status={m.risk_category} tone={m.risk_category === 'HIGH' ? 'danger' : m.risk_category === 'MEDIUM' ? 'warning' : 'success'} /> : <span className="text-muted-foreground">—</span>) },
          { id: 'submitted', header: 'Submitted', cell: (m) => <span className="text-muted-foreground text-sm">{m.submitted_at ? formatDateTime(m.submitted_at) : '—'}</span> },
        ]}
      />
      <CreateMerchantDialog open={creating} onOpenChange={setCreating} detailBase={detailBase} />
    </>
  );
}
