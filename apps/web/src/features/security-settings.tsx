'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { changePasswordSchema } from '@pay2all/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { TotpEnrollment } from '@/components/auth/totp-enrollment';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { api, ApiError, logout } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { Me, SessionRow } from '@/lib/api/types';
import { ME_QUERY_KEY } from '@/lib/auth/use-me';

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

function ChangePasswordCard() {
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof changePasswordSchema>>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: '', new_password: '' },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/v1/auth/password/change', values);
      form.reset();
      toast.success('Password changed. Other sessions were signed out.');
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) form.setError('new_password', { message: err.details.map((d) => d.message).join('. ') });
      else setError(err);
    }
  });
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing your password signs out every other session.</CardDescription>
      </CardHeader>
      <CardContent>
        <FormError error={error} />
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" noValidate>
          <FormField label="Current password" type="password" autoComplete="current-password" error={form.formState.errors.current_password?.message} {...form.register('current_password')} />
          <FormField label="New password" type="password" autoComplete="new-password" hint="At least 12 characters" error={form.formState.errors.new_password?.message} {...form.register('new_password')} />
          <div className="md:col-span-2">
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Update password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(codes)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">Each code works once if you lose your authenticator. Store them in a password manager — they won&apos;t be shown again.</p>
        <div className="bg-muted grid grid-cols-2 gap-2 rounded-lg p-4 font-mono text-sm select-all">
          {codes?.map((c) => <span key={c}>{c}</span>)}
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(codes?.join('\n') ?? '');
            toast.success('Copied');
          }}
        >
          Copy codes
        </Button>
        <Button onClick={onClose}>I&apos;ve saved them</Button>
      </DialogContent>
    </Dialog>
  );
}

function RegenerateCodes({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <FormField label="Authenticator code" name="regen-code" inputMode="numeric" maxLength={6} className="w-36 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
      <Button
        variant="outline"
        disabled={busy || code.length !== 6}
        onClick={async () => {
          setBusy(true);
          try {
            const res = await api.post<{ recovery_codes: string[] }>('/v1/auth/mfa/recovery-codes', { code });
            setCode('');
            onCodes(res.recovery_codes);
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Generate new recovery codes
      </Button>
    </div>
  );
}

function MfaCard({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            {me.mfa.required ? 'Required for your role.' : 'Protect your account with an authenticator app.'}
          </CardDescription>
        </div>
        <StatusBadge status={me.mfa.enabled ? 'ENABLED' : 'DISABLED'} tone={me.mfa.enabled ? 'success' : 'warning'} />
      </CardHeader>
      <CardContent>
        {me.mfa.enabled ? (
          <div className="space-y-4">
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <ShieldCheck className="text-success size-4" /> Authenticator app is active. Codes are required at every sign-in.
            </p>
            <p className="text-sm">
              Recovery codes remaining: <span className={me.mfa.recovery_codes_remaining < 3 ? 'text-destructive font-semibold' : 'font-semibold'}>{me.mfa.recovery_codes_remaining}</span>
            </p>
            <RegenerateCodes onCodes={setCodes} />
          </div>
        ) : (
          <Button variant="outline" onClick={() => setEnrolling(true)}>
            <ShieldOff /> Set up authenticator
          </Button>
        )}
      </CardContent>
      <Dialog open={enrolling} onOpenChange={setEnrolling}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
          </DialogHeader>
          {enrolling && (
            <TotpEnrollment
              onEnabled={(recoveryCodes) => {
                setEnrolling(false);
                setCodes(recoveryCodes);
                toast.success('Two-factor authentication enabled');
                void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <RecoveryCodesDialog codes={codes} onClose={() => { setCodes(null); void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }); }} />
    </Card>
  );
}

function SessionsCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => api.get<SessionRow[]>('/v1/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revokeAll = useMutation({
    mutationFn: () => api.post('/v1/auth/logout-all'),
    onSuccess: async () => {
      await logout();
      queryClient.clear();
      router.replace('/login');
    },
  });

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>Devices currently signed in to your account.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>
          <LogOut /> Sign out everywhere
        </Button>
      </CardHeader>
      <CardContent>
        <DataTable
          rows={sessions.data}
          loading={sessions.isPending}
          error={toTableError(sessions.error)}
          onRetry={() => void sessions.refetch()}
          rowKey={(s) => s.id}
          columns={[
            {
              id: 'device',
              header: 'Device',
              cell: (s) => (
                <div>
                  <p className="font-medium">{describeAgent(s.user_agent)} {s.current && <StatusBadge status="THIS DEVICE" tone="primary" className="ml-1" />}</p>
                  <p className="text-muted-foreground font-mono text-xs">{s.ip_address ?? '—'}</p>
                </div>
              ),
            },
            { id: 'mfa', header: 'MFA', cell: (s) => (s.mfa_verified ? 'Verified' : '—') },
            { id: 'last', header: 'Last active', cell: (s) => <span title={formatDateTime(s.last_used_at)}>{formatRelative(s.last_used_at)}</span> },
            { id: 'created', header: 'Signed in', cell: (s) => formatDateTime(s.created_at) },
            {
              id: 'actions',
              header: '',
              align: 'right',
              cell: (s) =>
                s.current ? null : (
                  <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                ),
            },
          ]}
        />
      </CardContent>
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out of every session?"
        description="All devices, including this one, will need to sign in again."
        confirmLabel="Sign out everywhere"
        destructive
        pending={revokeAll.isPending}
        onConfirm={() => revokeAll.mutate()}
      />
    </Card>
  );
}

export function SecuritySettings({ me }: { me: Me }) {
  return (
    <>
      <PageHeader title="Security" description="Password, two-factor authentication and signed-in devices." />
      <div className="space-y-6">
        <MfaCard me={me} />
        <ChangePasswordCard />
        <SessionsCard />
      </div>
    </>
  );
}
