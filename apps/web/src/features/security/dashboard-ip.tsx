'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Loader2, Lock, LockOpen, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { DashboardIpList, Me } from '@/lib/api/types';

const KEY = ['security', 'dashboard-ip'];

/**
 * Organization-wide sign-in allowlist (docs/SECURITY.md §1.8). Empty = sign in from anywhere. The API
 * refuses any change that would block the person making it.
 */
export function DashboardIpCard({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const canManage = me.permissions.includes('user.manage');
  const isPlatform = me.organization.type === 'PLATFORM';
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [removing, setRemoving] = useState<DashboardIpList['rules'][number] | null>(null);
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<DashboardIpList>('/v1/security/dashboard-ip') });
  const rules = list.data?.rules ?? [];
  const yourIp = list.data?.your_ip;

  const add = useMutation({
    mutationFn: (body: { cidr: string; label?: string }) => api.post('/v1/security/dashboard-ip', body),
    onSuccess: () => {
      setCidr('');
      setLabel('');
      toast.success('Address allowed');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/security/dashboard-ip/${id}`),
    onSuccess: () => {
      setRemoving(null);
      toast.success('Entry removed');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      setRemoving(null);
      toast.error(errorMessage(e));
    },
  });

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2"><Globe className="size-4" /> Sign-in IP allowlist</CardTitle>
          <CardDescription>
            {isPlatform
              ? 'Limit where platform staff can sign in to the admin console, e.g. your office network or VPN.'
              : `Limit where your team can sign in to the ${me.organization.name} dashboard, e.g. your office network.`}{' '}
            API keys have their own allowlist under Developers.
          </CardDescription>
        </div>
        {rules.length ? (
          <Badge variant="secondary" className="gap-1"><Lock className="size-3" /> Restricted</Badge>
        ) : (
          <Badge variant="outline" className="gap-1"><LockOpen className="size-3" /> Open</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {list.data && !list.data.enforced && (
          <p className="bg-warning/10 text-warning-foreground rounded-md px-3 py-2 text-sm">Enforcement is switched off on this server (DASHBOARD_IP_ALLOWLIST_ENFORCED). Entries are kept but not checked.</p>
        )}
        <p className="text-muted-foreground text-sm">
          {rules.length ? 'Sign-in and every dashboard request must come from one of these addresses.' : 'No entries: your team can sign in from any network.'}
          {yourIp && <> Your current address is <span className="text-foreground font-mono">{yourIp}</span>.</>}
        </p>
        {rules.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div>
                  <p className="font-mono text-sm">{r.cidr}</p>
                  <p className="text-muted-foreground text-xs">{r.label ?? 'No label'} · added {formatDateTime(r.created_at)}</p>
                </div>
                {canManage && (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoving(r)}>
                    <Trash2 /> Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({ cidr: cidr.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
            }}
          >
            <FormField name="dashboard-ip-cidr" label="IP address or range" placeholder="203.0.113.10 or 203.0.113.0/24" className="font-mono" value={cidr} onChange={(e) => setCidr(e.target.value)} />
            <FormField name="dashboard-ip-label" label="Label (optional)" placeholder="Head office" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="flex gap-2">
              <Button type="submit" disabled={!cidr.trim() || add.isPending}>
                {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add
              </Button>
              {yourIp && !rules.some((r) => r.cidr.startsWith(`${yourIp}/`)) && (
                <Button type="button" variant="outline" onClick={() => { setCidr(yourIp); if (!label) setLabel('Current network'); }}>
                  Use my IP
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.cidr ?? ''}?`}
        description={rules.length === 1 ? 'This is the last entry: sign-in will be allowed from any network again.' : 'People on this network will no longer be able to sign in.'}
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Card>
  );
}
