'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { ErrorState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Input } from '@pay2all/ui/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, IndianRupee, Search, Store, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { type AgentAdminOverview, type AgentAdminRow, type AgentPlanCode, fmtMobile, inr, istDate } from '../api';

export const ADMIN_AGENTS_KEY = ['admin', 'agents'];

function Overview() {
  const q = useQuery({ queryKey: [...ADMIN_AGENTS_KEY, 'overview'], queryFn: () => api.get<AgentAdminOverview>('/v1/admin/agents/overview') });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const o = q.data;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Agents" value={o?.agents.toLocaleString('en-IN')} icon={Store} hint={o ? o.by_plan.map((p) => `${p.name} ${p.agents}`).join(' · ') : undefined} loading={!o} />
      <StatCard label="New this month" value={o?.new_this_month.toLocaleString('en-IN')} icon={UserPlus} loading={!o} />
      <StatCard label="Entries this month" value={o?.transactions_this_month.toLocaleString('en-IN')} icon={ArrowLeftRight} hint={o ? `${inr(o.volume_this_month)} recorded` : undefined} loading={!o} />
      <StatCard label="Plan revenue this month" value={o && inr(o.plan_revenue_this_month)} icon={IndianRupee} hint={o ? `${o.plan_orders_this_month} paid orders` : undefined} loading={!o} />
    </div>
  );
}

/** Admin → Agents: program overview and the agents list. */
export function AdminAgents() {
  const router = useRouter();
  const page = useCursorPagination();
  const { reset } = page;
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState<AgentPlanCode | 'ALL'>('ALL');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const q = useQuery({
    queryKey: [...ADMIN_AGENTS_KEY, 'list', search, plan, page.cursor],
    queryFn: () => apiRequest<AgentAdminRow[]>('/v1/admin/agents', { query: { search: search || undefined, plan: plan === 'ALL' ? undefined : plan, cursor: page.cursor, limit: 25 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-5">
      <Overview />
      <DataTable
        rows={q.data?.data}
        rowKey={(r) => r.id}
        loading={q.isFetching}
        error={toTableError(q.error)}
        onRetry={() => void q.refetch()}
        onRowClick={(r) => router.push(`/admin/agents/${r.id}`)}
        empty={{ title: 'No agents found', description: search || plan !== 'ALL' ? 'Try another search or plan.' : 'Agents appear here when they sign up.' }}
        toolbar={
          <>
            <div className="relative w-full max-w-xs">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden />
              <Input
                aria-label="Search agents"
                placeholder="Shop, owner, email or mobile"
                className="pl-8"
                value={term}
                onChange={(e) => {
                  const v = e.target.value;
                  setTerm(v);
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    setSearch(v.trim());
                    reset();
                  }, 300);
                }}
              />
            </div>
            <Select
              value={plan}
              onValueChange={(v) => {
                setPlan(v as AgentPlanCode | 'ALL');
                reset();
              }}
            >
              <SelectTrigger className="w-40" aria-label="Plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All plans</SelectItem>
                <SelectItem value="FREE">Free</SelectItem>
                <SelectItem value="STARTER">Starter</SelectItem>
                <SelectItem value="BUSINESS">Business</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
        pagination={{
          hasPrevious: page.hasPrevious,
          hasNext: Boolean(q.data?.meta?.has_more),
          onPrevious: page.previous,
          onNext: () => page.next(q.data?.meta?.next_cursor),
          pageLabel: `Page ${page.page}`,
        }}
        columns={[
          {
            id: 'shop',
            header: 'Shop',
            cell: (r) => (
              <div>
                <p className="font-medium">{r.shop_name}</p>
                <p className="text-muted-foreground text-xs">
                  {r.owner_name}
                  {r.city ? ` · ${r.city}` : ''}
                </p>
              </div>
            ),
          },
          {
            id: 'contact',
            header: 'Contact',
            cell: (r) => (
              <div className="text-xs">
                <p>{r.email}</p>
                <p className="text-muted-foreground">{fmtMobile(r.mobile)}</p>
              </div>
            ),
          },
          {
            id: 'plan',
            header: 'Plan',
            cell: (r) => (
              <div className="text-xs">
                <p className="text-sm font-medium">{r.plan_code}</p>
                {r.subscribed_plan_code !== r.plan_code ? <p className="text-warning-foreground dark:text-warning">{r.subscribed_plan_code} lapsed</p> : r.plan_expires_at ? <p className="text-muted-foreground">till {istDate(r.plan_expires_at)}</p> : null}
              </div>
            ),
          },
          { id: 'txns', header: 'Entries (month)', align: 'right', cell: (r) => <span className="tabular-nums">{r.transactions_this_month.toLocaleString('en-IN')}</span> },
          { id: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { id: 'joined', header: 'Joined', cell: (r) => <span className="text-muted-foreground text-xs whitespace-nowrap">{istDate(r.created_at)}</span> },
        ]}
      />
    </div>
  );
}
