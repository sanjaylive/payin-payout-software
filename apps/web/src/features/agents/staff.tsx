'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { initials } from '@pay2all/ui/lib/format';
import { agentStaffCreateSchema } from '@pay2all/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { type AgentStaffList, fmtMobile, istDateTime } from './api';
import { AGENT_KEY } from './hooks';

const KEY = [...AGENT_KEY, 'staff'];
type Values = z.input<typeof agentStaffCreateSchema>;
type Member = AgentStaffList['members'][number];

/** /agent/staff: counter operator logins, within the plan's limit (owner included). */
export function AgentStaff() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<AgentStaffList>('/v1/agent/staff') });
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle(m: Member) {
    setBusy(true);
    try {
      qc.setQueryData(KEY, await api.post<AgentStaffList>(`/v1/agent/staff/${m.user_id}/status`, { active: !m.active }));
      toast.success(m.active ? `${m.name} can no longer sign in` : `${m.name} can sign in again`);
      setToggling(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const full = s ? s.active >= s.staff_limit : false;
  return (
    <>
      <PageHeader
        title="Staff"
        description="Logins for your counter staff. They can record entries and print receipts, but not change settings or statuses."
        actions={
          <Button onClick={() => setAdding(true)} disabled={!s || full}>
            <UserPlus /> Add operator
          </Button>
        }
      />
      {!s ? (
        <Skeleton className="h-60 rounded-xl" />
      ) : (
        <div className="space-y-3">
          <div className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-sm">
            <span>
              <span className="font-semibold tabular-nums">
                {s.active} of {s.staff_limit}
              </span>{' '}
              logins in use (you included)
            </span>
            {full && (
              <span className="text-muted-foreground">
                Limit reached.{' '}
                {can('agent.billing.manage') && (
                  <Link href="/agent/plan" className="text-primary font-medium hover:underline">
                    Upgrade for more
                  </Link>
                )}
              </span>
            )}
          </div>
          <ul className="bg-card divide-y overflow-hidden rounded-xl border">
            {s.members.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold">{initials(m.name)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.name}
                    {m.is_you && <span className="text-muted-foreground font-normal"> (you)</span>}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {m.role_name} · {m.email}
                    {m.mobile ? ` · ${fmtMobile(m.mobile)}` : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">Last sign-in {m.last_login_at ? istDateTime(m.last_login_at) : 'never'}</p>
                </div>
                <StatusBadge status={m.active ? 'ACTIVE' : 'DISABLED'} />
                {!m.is_you && m.role === 'AGENT_OPERATOR' && (
                  <Button variant={m.active ? 'outline' : 'default'} size="sm" className="h-9" onClick={() => setToggling(m)}>
                    {m.active ? 'Disable' : 'Enable'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <AddOperator open={adding} onOpenChange={setAdding} onSaved={(list) => qc.setQueryData(KEY, list)} />
      <ConfirmDialog
        open={Boolean(toggling)}
        onOpenChange={(o) => !o && setToggling(null)}
        title={toggling?.active ? `Disable ${toggling.name}?` : `Enable ${toggling?.name ?? ''}?`}
        description={toggling?.active ? 'They are signed out everywhere and cannot sign in until you enable them again.' : 'They can sign in again with their password.'}
        confirmLabel={toggling?.active ? 'Disable' : 'Enable'}
        destructive={toggling?.active}
        pending={busy}
        onConfirm={() => toggling && void toggle(toggling)}
      />
    </>
  );
}

function AddOperator({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: (s: AgentStaffList) => void }) {
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values, unknown, z.output<typeof agentStaffCreateSchema>>({ resolver: zodResolver(agentStaffCreateSchema), defaultValues: { name: '', email: '', mobile: '', password: '' } });
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      onSaved(await api.post<AgentStaffList>('/v1/agent/staff', v));
      toast.success(`${v.name} can now sign in`);
      form.reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) for (const d of err.details) form.setError(d.path as keyof Values, { message: d.message });
      setError(err);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add counter operator</DialogTitle>
          <DialogDescription>Share the email and starting password with them in person. They can change the password after signing in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
          <FormError error={error} />
          <FormField id="op-name" label="Name" autoComplete="off" error={e.name?.message} {...form.register('name')} />
          <FormField id="op-email" label="Email" type="email" autoComplete="off" error={e.email?.message} {...form.register('email')} />
          <FormField id="op-mobile" label="Mobile number" type="tel" inputMode="tel" autoComplete="off" error={e.mobile?.message} {...form.register('mobile')} />
          <FormField id="op-password" label="Starting password" type="text" autoComplete="new-password" hint="At least 12 characters; not their email or mobile" error={e.password?.message} {...form.register('password')} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <UserPlus />} Add operator
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
