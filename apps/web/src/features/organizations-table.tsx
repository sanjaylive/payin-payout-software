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
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime } from '@pay2all/ui/lib/format';
import type { OrganizationType } from '@pay2all/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { Organization } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

const createSchema = z.object({ name: z.string().trim().min(2, 'Enter a name').max(120), parent_id: z.string().optional() });
const TYPE_LABEL: Record<string, string> = { MERCHANT: 'merchant', RESELLER: 'reseller', API_PARTNER: 'API partner' };

function CreateOrganizationDialog({ type, open, onOpenChange }: { type: Exclude<OrganizationType, 'PLATFORM'>; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const resellers = useQuery({
    queryKey: ['organizations', 'RESELLER', 'options'],
    queryFn: () => api.list<Organization>('/v1/organizations', { type: 'RESELLER', status: 'ACTIVE', limit: 100 }),
    enabled: open && type === 'MERCHANT',
  });
  const form = useForm<z.input<typeof createSchema>>({ resolver: zodResolver(createSchema), defaultValues: { name: '', parent_id: 'none' } });
  const onSubmit = form.handleSubmit(async ({ name, parent_id }) => {
    setError(null);
    try {
      await api.post('/v1/organizations', { name, type, ...(parent_id && parent_id !== 'none' ? { parent_id } : {}) });
      toast.success(`${name} created`);
      form.reset();
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
    } catch (err) {
      setError(err);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {TYPE_LABEL[type]}</DialogTitle>
          <DialogDescription>
            {type === 'MERCHANT' ? 'Creates the merchant account shell. KYC onboarding (Phase 2) completes the profile before go-live.' : 'Creates the organization. Invite its administrator from Users & Roles.'}
          </DialogDescription>
        </DialogHeader>
        <FormError error={error} />
        <form id="org-form" onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label="Display name" error={form.formState.errors.name?.message} {...form.register('name')} />
          {type === 'MERCHANT' && (
            <div className="space-y-1.5">
              <Label htmlFor="parent">Reseller</Label>
              <Controller
                control={form.control}
                name="parent_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="parent" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Direct (Pay2All)</SelectItem>
                      {resellers.data?.data.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="org-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Server-paginated organization listing with audited status changes. */
export function OrganizationsTable({ type, allowCreate = true }: { type: Exclude<OrganizationType, 'PLATFORM'>; allowCreate?: boolean }) {
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const status = params.get('status') ?? 'ALL';
  const pager = useCursorPagination();
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<Organization | null>(null);

  const orgs = useQuery({
    queryKey: ['organizations', type, status, pager.cursor, submittedSearch],
    queryFn: () =>
      api.list<Organization>('/v1/organizations', { type, status: status === 'ALL' ? undefined : status, cursor: pager.cursor, limit: 25, search: submittedSearch || undefined }),
    placeholderData: keepPreviousData,
  });

  const changeStatus = useMutation({
    mutationFn: ({ org, reason }: { org: Organization; reason: string }) =>
      api.patch(`/v1/organizations/${org.id}/status`, { status: org.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED', reason }),
    onSuccess: () => {
      toast.success('Status updated and recorded in the audit log');
      setTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <DataTable
        toolbar={
          <>
            <Tabs
              value={status}
              onValueChange={(v) => {
                pager.reset();
                const q = new URLSearchParams(params);
                if (v === 'ALL') q.delete('status');
                else q.set('status', v);
                router.replace(`?${q.toString()}`);
              }}
            >
              <TabsList>
                <TabsTrigger value="ALL">All</TabsTrigger>
                <TabsTrigger value="ACTIVE">Active</TabsTrigger>
                <TabsTrigger value="SUSPENDED">Suspended</TabsTrigger>
              </TabsList>
            </Tabs>
            <form
              className="relative w-full max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                pager.reset();
                setSubmittedSearch(search.trim());
              }}
            >
              <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID" className="pl-8" aria-label="Search" />
            </form>
            {allowCreate && can('organization.manage') && (
              <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
                <Plus /> New {TYPE_LABEL[type]}
              </Button>
            )}
          </>
        }
        rows={orgs.data?.data}
        loading={orgs.isFetching}
        error={toTableError(orgs.error)}
        onRetry={() => void orgs.refetch()}
        rowKey={(o) => o.id}
        empty={{ title: `No ${TYPE_LABEL[type]}s found` }}
        pagination={{
          hasPrevious: pager.hasPrevious,
          hasNext: Boolean(orgs.data?.meta?.has_more),
          onPrevious: pager.previous,
          onNext: () => pager.next(orgs.data?.meta?.next_cursor),
          pageLabel: `Page ${pager.page}`,
        }}
        columns={[
          {
            id: 'name',
            header: 'Name',
            cell: (o) => (
              <div>
                <p className="font-medium">{o.name}</p>
                <p className="text-muted-foreground font-mono text-xs">{o.id}</p>
              </div>
            ),
          },
          { id: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
          { id: 'created', header: 'Created', cell: (o) => <span className="text-muted-foreground text-sm">{formatDateTime(o.created_at)}</span> },
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (o) =>
              can('organization.manage') && o.status !== 'CLOSED' ? (
                <Button variant={o.status === 'SUSPENDED' ? 'outline' : 'ghost'} size="sm" onClick={() => setTarget(o)}>
                  {o.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
                </Button>
              ) : null,
          },
        ]}
      />
      {allowCreate && <CreateOrganizationDialog type={type} open={createOpen} onOpenChange={setCreateOpen} />}
      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title={target?.status === 'SUSPENDED' ? `Reactivate ${target.name}?` : `Suspend ${target?.name}?`}
        description={
          target?.status === 'SUSPENDED'
            ? 'Members regain access immediately.'
            : 'All members lose dashboard access on their next request. Financial operations are blocked.'
        }
        confirmLabel={target?.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
        destructive={target?.status !== 'SUSPENDED'}
        requireReason
        pending={changeStatus.isPending}
        onConfirm={(reason) => target && changeStatus.mutate({ org: target, reason: reason ?? '' })}
      />
    </>
  );
}
