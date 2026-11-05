'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { initials } from '@pay2all/ui/lib/format';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowLeftRight, Contact, Copy, Eye, Landmark, Loader2, Pencil, Plus, Search, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { api, apiRequest } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { type AgentBeneficiary, type AgentCustomer, type AgentCustomerDetail, fmtMobile, ID_TYPE_LABEL, istDate, istDateTime } from './api';
import { BeneficiaryForm, CustomerForm } from './customer-forms';
import { AGENT_KEY, CUSTOMERS_KEY } from './hooks';
import { TransactionsList } from './transactions';

/** /agent/customers: search by name or mobile, add new. */
export function CustomersPage() {
  const can = useCan();
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const list = useInfiniteQuery({
    queryKey: [...CUSTOMERS_KEY, 'list', search],
    queryFn: ({ pageParam }) => apiRequest<AgentCustomer[]>('/v1/agent/customers', { query: { search: search || undefined, cursor: pageParam, limit: 30 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Customers"
        description="People you serve. Find them by mobile number when they come back."
        actions={
          can('agent.desk.write') ? (
            <Button onClick={() => setAdding(true)}>
              <UserPlus /> Add customer
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
          <Input
            aria-label="Search customers"
            placeholder="Name or mobile number"
            className="h-11 pl-9"
            value={term}
            onChange={(e) => {
              const v = e.target.value;
              setTerm(v);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setSearch(v.trim()), 300);
            }}
          />
        </div>
        <div className="bg-card overflow-hidden rounded-xl border">
          {list.isError ? (
            <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
          ) : list.isPending ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
              <Contact className="size-6" aria-hidden />
              {search ? 'No customer matches.' : 'No customers yet. They are added when you record a money transfer, or here.'}
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((c) => (
                <li key={c.id}>
                  <Link href={`/agent/customers/${c.id}`} className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3">
                    <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold">{initials(c.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {fmtMobile(c.mobile)}
                        {c.city ? ` · ${c.city}` : ''}
                      </span>
                    </span>
                    <span className="text-muted-foreground hidden text-xs sm:block">Added {istDate(c.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="border-t p-3">
              <Button variant="outline" className="h-11 w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
              </Button>
            </div>
          )}
        </div>
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add customer</DialogTitle>
            <DialogDescription>The mobile number is how you find them next time.</DialogDescription>
          </DialogHeader>
          <CustomerForm
            onCancel={() => setAdding(false)}
            onSaved={(c) => {
              setAdding(false);
              router.push(`/agent/customers/${c.id}`);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children || '—'}</dd>
    </div>
  );
}

/** /agent/customers/<id>: details, beneficiaries, history. */
export function CustomerDetailPage({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const write = can('agent.desk.write');
  const q = useQuery({ queryKey: [...CUSTOMERS_KEY, id], queryFn: () => api.get<AgentCustomerDetail>(`/v1/agent/customers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [addingBen, setAddingBen] = useState(false);
  const [removing, setRemoving] = useState<AgentBeneficiary | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [fullId, setFullId] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  async function reveal() {
    setRevealing(true);
    try {
      const r = await api.get<{ id_type: string | null; id_number: string | null }>(`/v1/agent/customers/${id}/id-number`);
      setFullId(r.id_number ?? '—');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevealing(false);
    }
  }

  async function remove(b: AgentBeneficiary) {
    setRemovingBusy(true);
    try {
      await api.delete(`/v1/agent/beneficiaries/${b.id}`);
      toast.success(`${b.name} removed`);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      setRemoving(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRemovingBusy(false);
    }
  }

  async function copy(v: string) {
    try {
      await navigator.clipboard.writeText(v);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const c = q.data;
  if (!c) return <Skeleton className="h-96 rounded-xl" />;
  const bens = c.beneficiaries.filter((b) => b.active);

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/agent/customers">
          <ArrowLeft /> Customers
        </Link>
      </Button>
      <div className="flex flex-wrap items-center gap-4">
        <span className="bg-primary/10 text-primary grid size-14 shrink-0 place-items-center rounded-full text-lg font-semibold">{initials(c.name)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{c.name}</h1>
          <p className="text-muted-foreground text-sm">
            <a href={`tel:${c.mobile}`} className="hover:text-foreground">
              {fmtMobile(c.mobile)}
            </a>{' '}
            · {c.transactions} {c.transactions === 1 ? 'entry' : 'entries'}
            {c.last_transaction_at ? ` · last ${istDate(c.last_transaction_at)}` : ''}
          </p>
        </div>
        {write && (
          <div className="flex w-full gap-2 sm:w-auto">
            <Button className="h-11 flex-1 sm:flex-none" asChild>
              <Link href={`/agent/new?type=MONEY_TRANSFER&customer=${c.id}`}>
                <ArrowLeftRight /> New transfer
              </Link>
            </Button>
            <Button variant="outline" className="h-11" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          </div>
        )}
      </div>

      <section className="bg-card rounded-xl border p-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Info label="Email">{c.email}</Info>
          <Info label="Date of birth">{c.date_of_birth ? istDate(`${c.date_of_birth}T00:00:00+05:30`) : null}</Info>
          <Info label="Address">{[c.address_line, c.city, c.pincode].filter(Boolean).join(', ')}</Info>
          <Info label="ID document">
            {c.id_type ? (
              <span className="flex flex-wrap items-center gap-2">
                {ID_TYPE_LABEL[c.id_type]} <span className="font-mono">{fullId ?? c.id_number_masked}</span>
                {write && c.id_number_masked && !fullId && (
                  <Button variant="ghost" size="xs" onClick={() => void reveal()} disabled={revealing}>
                    {revealing ? <Loader2 className="animate-spin" /> : <Eye />} Show full ID
                  </Button>
                )}
                {fullId && fullId !== '—' && (
                  <Button variant="ghost" size="xs" onClick={() => void copy(fullId)}>
                    <Copy /> Copy
                  </Button>
                )}
              </span>
            ) : null}
          </Info>
          <Info label="Note">{c.note}</Info>
          <Info label="Customer since">{istDateTime(c.created_at)}</Info>
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Beneficiaries</h2>
          {write && (
            <Button variant="outline" size="sm" onClick={() => setAddingBen(true)}>
              <Plus /> Add
            </Button>
          )}
        </div>
        {bens.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">No beneficiaries yet.</p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {bens.map((b) => (
              <li key={b.id} className="bg-card flex items-start gap-3 rounded-xl border p-3">
                <span className="bg-muted grid size-10 shrink-0 place-items-center rounded-full">
                  <Landmark className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-medium">
                    {b.name}
                    {b.relation ? <span className="text-muted-foreground font-normal"> · {b.relation}</span> : null}
                  </p>
                  {b.account_number && (
                    <p className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                      {b.account_number} · {b.ifsc}
                      <button type="button" className="hover:text-foreground rounded p-1" aria-label="Copy account number" onClick={() => void copy(b.account_number!)}>
                        <Copy className="size-3.5" />
                      </button>
                    </p>
                  )}
                  {b.bank_name && <p className="text-muted-foreground text-xs">{b.bank_name}</p>}
                  {b.upi_id && <p className="text-muted-foreground text-xs">UPI {b.upi_id}</p>}
                </div>
                {write && (
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${b.name}`} onClick={() => setRemoving(b)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">History</h2>
        <TransactionsList customerId={c.id} compact />
      </section>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>Past receipts keep the details they were printed with.</DialogDescription>
          </DialogHeader>
          <CustomerForm customer={c} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={addingBen} onOpenChange={setAddingBen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add beneficiary</DialogTitle>
            <DialogDescription>Who {c.name} sends money to.</DialogDescription>
          </DialogHeader>
          <BeneficiaryForm customerId={c.id} onCancel={() => setAddingBen(false)} onSaved={() => setAddingBen(false)} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="It will no longer be offered for new transfers. Past receipts keep its details."
        confirmLabel="Remove"
        destructive
        pending={removingBusy}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  );
}
