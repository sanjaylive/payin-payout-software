'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@pay2all/ui/components/ui/dropdown-menu';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatRelative } from '@pay2all/ui/lib/format';
import { createUserSchema } from '@pay2all/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal, Search, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { Me, RoleRow, UserRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

function InviteUserDialog({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/v1/roles'), enabled: open });
  const grantable = (roles.data ?? []).filter((r) => r.scope === me.organization.type && r.permissions.every((p) => me.permissions.includes(p)));
  const form = useForm<z.input<typeof createUserSchema>>({ resolver: zodResolver(createUserSchema), defaultValues: { name: '', email: '', role_key: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/v1/users', values);
      toast.success(`Invitation sent to ${values.email}`);
      form.reset();
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(err);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>They&apos;ll receive an email to set their password. Invitations expire after 72 hours.</DialogDescription>
        </DialogHeader>
        <FormError error={error} />
        <form id="invite-form" onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label="Full name" error={form.formState.errors.name?.message} {...form.register('name')} />
          <FormField label="Work email" type="email" error={form.formState.errors.email?.message} {...form.register('email')} />
          <div className="space-y-1.5">
            <Label htmlFor="role_key">Role</Label>
            <Controller
              control={form.control}
              name="role_key"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="role_key" className="w-full" aria-invalid={Boolean(form.formState.errors.role_key)}>
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {grantable.map((r) => (
                      <SelectItem key={r.key} value={r.key}>
                        {r.name} <span className="text-muted-foreground">— {r.description}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {form.formState.errors.role_key && <p className="text-destructive text-xs">Select a role</p>}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="invite-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Send invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Team / users listing. Tenant users see their org's members; platform staff see everyone in scope. */
export function UsersTable({ me, platformView = false }: { me: Me; platformView?: boolean }) {
  const can = useCan();
  const queryClient = useQueryClient();
  const pager = useCursorPagination();
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState<{ kind: 'remove' | 'disable' | 'enable'; user: UserRow; roleKey?: string } | null>(null);

  const users = useQuery({
    queryKey: ['users', pager.cursor, submittedSearch],
    queryFn: () => api.list<UserRow>('/v1/users', { cursor: pager.cursor, limit: 25, search: submittedSearch || undefined }),
    placeholderData: keepPreviousData,
  });

  const action = useMutation({
    mutationFn: async ({ reason }: { reason?: string }) => {
      if (!pending) return;
      if (pending.kind === 'remove') await api.delete(`/v1/users/${pending.user.id}/roles/${pending.roleKey}`);
      else await api.patch(`/v1/users/${pending.user.id}/status`, { status: pending.kind === 'disable' ? 'DISABLED' : 'ACTIVE', reason });
    },
    onSuccess: () => {
      toast.success('Saved');
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <DataTable
        toolbar={
          <>
            <form
              className="relative w-full max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                pager.reset();
                setSubmittedSearch(search.trim());
              }}
            >
              <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="pl-8" aria-label="Search users" />
            </form>
            {can('user.manage') && (
              <Button className="ml-auto" onClick={() => setInviteOpen(true)}>
                <UserPlus /> Invite member
              </Button>
            )}
          </>
        }
        rows={users.data?.data}
        loading={users.isFetching}
        error={toTableError(users.error)}
        onRetry={() => void users.refetch()}
        rowKey={(u) => u.id}
        empty={{ title: 'No users found', description: submittedSearch ? 'Try a different search.' : undefined }}
        pagination={{
          hasPrevious: pager.hasPrevious,
          hasNext: Boolean(users.data?.meta?.has_more),
          onPrevious: pager.previous,
          onNext: () => pager.next(users.data?.meta?.next_cursor),
          pageLabel: `Page ${pager.page}`,
        }}
        columns={[
          {
            id: 'user',
            header: 'Member',
            cell: (u) => (
              <div>
                <p className="font-medium">{u.name}{u.id === me.user.id && <span className="text-muted-foreground"> (you)</span>}</p>
                <p className="text-muted-foreground text-xs">{u.email}</p>
              </div>
            ),
          },
          {
            id: 'roles',
            header: platformView ? 'Organization · role' : 'Role',
            cell: (u) => (
              <div className="flex flex-wrap gap-1">
                {u.memberships.map((m) => (
                  <Badge key={`${m.organization_id}-${m.role_key}`} variant="secondary" className="font-normal">
                    {platformView ? `${m.organization_name} · ` : ''}{m.role_name}
                  </Badge>
                ))}
              </div>
            ),
          },
          { id: 'status', header: 'Status', cell: (u) => <StatusBadge status={u.locked ? 'LOCKED' : u.status} /> },
          { id: 'login', header: 'Last sign-in', cell: (u) => <span className="text-muted-foreground text-sm">{u.last_login_at ? formatRelative(u.last_login_at) : 'Never'}</span> },
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (u) =>
              can('user.manage') && u.id !== me.user.id ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}><MoreHorizontal /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {u.memberships
                      .filter((m) => m.organization_id === me.organization.id)
                      .map((m) => (
                        <DropdownMenuItem key={m.role_key} onSelect={() => setPending({ kind: 'remove', user: u, roleKey: m.role_key })}>
                          Remove {m.role_name} role
                        </DropdownMenuItem>
                      ))}
                    {platformView && (
                      <DropdownMenuItem
                        variant={u.status === 'DISABLED' ? 'default' : 'destructive'}
                        onSelect={() => setPending({ kind: u.status === 'DISABLED' ? 'enable' : 'disable', user: u })}
                      >
                        {u.status === 'DISABLED' ? 'Enable account' : 'Disable account'}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null,
          },
        ]}
      />
      <InviteUserDialog me={me} open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === 'remove' ? 'Remove role?' : pending?.kind === 'disable' ? 'Disable account?' : 'Enable account?'}
        description={
          pending?.kind === 'disable'
            ? `${pending.user.name} will be signed out everywhere and blocked from every organization.`
            : pending?.kind === 'remove'
              ? `${pending.user.name} loses this role immediately.`
              : `${pending?.user.name} will be able to sign in again.`
        }
        destructive={pending?.kind !== 'enable'}
        requireReason={pending?.kind === 'disable' || pending?.kind === 'enable'}
        pending={action.isPending}
        onConfirm={(reason) => action.mutate({ reason })}
      />
    </>
  );
}
