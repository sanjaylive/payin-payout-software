'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowLeftRight, Ban, CircleDollarSign, Crown, IndianRupee, Loader2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { type AgentAdminDetail, type AgentPlanCode, addDays, fmtMobile, inr, istDate, istDateTime, istToday } from '../api';
import { ADMIN_AGENTS_KEY } from './admin-agents';

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children || '—'}</dd>
    </div>
  );
}

/** Admin → Agents → one agent: profile, plan, usage, orders; grant a plan, suspend or reactivate. */
export function AdminAgentDetail({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('agent.admin.manage');
  const key = [...ADMIN_AGENTS_KEY, id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<AgentAdminDetail>(`/v1/admin/agents/${id}`) });
  const [granting, setGranting] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setStatus(status: 'ACTIVE' | 'SUSPENDED', reason?: string) {
    setBusy(true);
    try {
      qc.setQueryData(key, await api.post<AgentAdminDetail>(`/v1/admin/agents/${id}/status`, { status, reason: reason ?? null }));
      await qc.invalidateQueries({ queryKey: ADMIN_AGENTS_KEY });
      toast.success(status === 'SUSPENDED' ? 'Agent suspended and signed out' : 'Agent reactivated');
      setStatusOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const a = q.data;
  if (!a) return <Skeleton className="h-96 rounded-xl" />;
  const suspended = a.status === 'SUSPENDED';
  const limit = a.plan.monthly_txn_limit;
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/admin/agents">
          <ArrowLeft /> Agents
        </Link>
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {a.shop_name} <StatusBadge status={a.status} />
          </h1>
          <p className="text-muted-foreground text-sm">
            {a.owner_name} · joined {istDate(a.created_at)}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setGranting(true)}>
              <Crown /> Change plan
            </Button>
            <Button variant={suspended ? 'default' : 'destructive'} onClick={() => setStatusOpen(true)}>
              {suspended ? <RotateCcw /> : <Ban />} {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Plan"
          value={a.plan.name}
          icon={Crown}
          hint={a.plan.lapsed_from ? `${a.plan.lapsed_from} lapsed` : a.plan.expires_at ? `till ${istDate(a.plan.expires_at)}` : 'No end date'}
        />
        <StatCard
          label="Entries this month"
          value={a.usage.transactions_this_month.toLocaleString('en-IN')}
          icon={ArrowLeftRight}
          hint={limit === null ? 'Unlimited' : `of ${limit.toLocaleString('en-IN')} · ${a.usage.staff}/${a.plan.staff_limit} logins`}
        />
        <StatCard label="Lifetime volume" value={inr(a.lifetime.volume)} icon={IndianRupee} hint={`${a.lifetime.transactions.toLocaleString('en-IN')} entries`} />
        <StatCard label="Lifetime fees" value={inr(a.lifetime.fees)} icon={CircleDollarSign} />
      </div>

      <section className="bg-card rounded-xl border p-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Email">{a.email}</Info>
          <Info label="Mobile">{fmtMobile(a.mobile)}</Info>
          <Info label="Address">{a.address}</Info>
          <Info label="UPI id">{a.upi_vpa}</Info>
          <Info label="Drive backup">{a.drive ? `${a.drive.status}${a.drive.last_backup_at ? ` · ${istDateTime(a.drive.last_backup_at)}` : ''}` : 'Not connected'}</Info>
          <Info label="Agent id">
            <span className="font-mono text-xs">{a.id}</span>
          </Info>
        </dl>
      </section>

      <section className="bg-card overflow-hidden rounded-xl border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Plan orders</h2>
        {a.orders.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Valid till</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="whitespace-nowrap">{istDateTime(o.created_at)}</TableCell>
                    <TableCell>
                      {o.plan_code} · {o.granted ? 'granted' : o.period.toLowerCase()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{o.granted ? '—' : inr(o.amount)}</TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{o.paid_at ? istDateTime(o.paid_at) : '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{o.period_end ? istDate(o.period_end) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <GrantDialog agent={a} open={granting} onOpenChange={setGranting} onDone={() => void qc.invalidateQueries({ queryKey: ADMIN_AGENTS_KEY })} />
      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title={suspended ? `Reactivate ${a.shop_name}?` : `Suspend ${a.shop_name}?`}
        description={suspended ? 'The owner and staff can sign in again.' : 'Everyone on this account is signed out and cannot sign in until you reactivate it. Their records are kept.'}
        confirmLabel={suspended ? 'Reactivate' : 'Suspend'}
        destructive={!suspended}
        requireReason={!suspended}
        pending={busy}
        onConfirm={(reason) => void setStatus(suspended ? 'ACTIVE' : 'SUSPENDED', reason)}
      />
    </div>
  );
}

function GrantDialog({ agent, open, onOpenChange, onDone }: { agent: AgentAdminDetail; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [plan, setPlan] = useState<AgentPlanCode>(agent.plan.code === 'FREE' ? 'STARTER' : agent.plan.code);
  const [until, setUntil] = useState(() => addDays(istToday(), 30));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/admin/agents/${agent.id}/plan`, { plan_code: plan, ...(plan === 'FREE' ? {} : { expires_at: until }), note: note.trim() || null });
      toast.success(plan === 'FREE' ? 'Reset to Free' : `${plan} granted until ${istDate(`${until}T12:00:00+05:30`)}`);
      onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>Grant a plan without payment until a date, or reset to Free. Recorded as a granted order.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormError error={error} />
          <div className="space-y-1.5">
            <Label htmlFor="g-plan">Plan</Label>
            <Select value={plan} onValueChange={(v) => setPlan(v as AgentPlanCode)}>
              <SelectTrigger id="g-plan" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FREE">Free (reset)</SelectItem>
                <SelectItem value="STARTER">Starter</SelectItem>
                <SelectItem value="BUSINESS">Business</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {plan !== 'FREE' && (
            <div className="space-y-1.5">
              <Label htmlFor="g-until">Until (end of day, IST)</Label>
              <Input id="g-until" type="date" min={addDays(istToday(), 1)} value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="g-note">Note (audit log)</Label>
            <Input id="g-note" maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, e.g. paid by bank transfer" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || (plan !== 'FREE' && !until)} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />} {plan === 'FREE' ? 'Reset to Free' : 'Grant plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
