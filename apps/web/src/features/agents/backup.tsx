'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CloudUpload, Crown, ExternalLink, FolderOpen, Loader2, Unplug } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { type AgentDrive, istDateTime } from './api';
import { AGENT_KEY } from './hooks';

const KEY = [...AGENT_KEY, 'drive'];

/** /agent/backup: copies of transactions and customers in the agent's own Google Drive. */
export function AgentBackup() {
  const can = useCan();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<AgentDrive>('/v1/agent/drive') });
  const [busy, setBusy] = useState<'connect' | 'backup' | 'auto' | 'disconnect' | null>(null);
  const [confirm, setConfirm] = useState(false);

  // Google sends the browser back with ?drive=connected|error: say so once, then tidy the URL.
  const result = params.get('drive');
  useEffect(() => {
    if (!result) return;
    if (result === 'connected') toast.success('Google Drive connected. The first backup is on its way.');
    else toast.error('Google Drive was not connected. Please try again.');
    void qc.invalidateQueries({ queryKey: KEY });
    router.replace(pathname);
  }, [result, qc, router, pathname]);

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(kind);
    try {
      done?.(await fn());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run('connect', () => api.post<{ url: string }>('/v1/agent/drive/connect'), (r) => {
      window.location.assign(r.url);
    });
  const backup = () =>
    run('backup', () => api.post<AgentDrive>('/v1/agent/drive/backup'), (s) => {
      qc.setQueryData(KEY, s);
      if (s.last_error) toast.error(s.last_error);
      else toast.success('Backed up to Google Drive');
    });
  const setAuto = (v: boolean) => run('auto', () => api.put<AgentDrive>('/v1/agent/drive/settings', { auto_backup: v }), (s) => qc.setQueryData(KEY, s));
  const disconnect = () =>
    run('disconnect', () => api.delete('/v1/agent/drive'), () => {
      toast.success('Google Drive disconnected. Files already there stay.');
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: KEY });
    });

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <>
      <PageHeader title="Backup" description="Keep a copy of your transactions and customers in your own Google Drive." />
      {!s ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : !s.available ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription>Google Drive backup is not set up on this platform yet.</AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-5">
          {!s.included_in_plan && (
            <div className="border-primary/30 bg-primary/5 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <p className="flex items-center gap-2 text-sm">
                <Crown className="text-primary size-4" aria-hidden /> Google Drive backup comes with the Starter and Business plans.
              </p>
              {can('agent.billing.manage') && (
                <Button asChild>
                  <Link href="/agent/plan">See plans</Link>
                </Button>
              )}
            </div>
          )}
          <section className="bg-card space-y-4 rounded-xl border p-4 sm:p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-full">
                <CloudUpload className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">{s.connected ? 'Connected to Google Drive' : 'Not connected'}</h2>
                <p className="text-muted-foreground text-sm">
                  {s.connected
                    ? `${s.google_email ?? 'Google account'} · last backup ${s.last_backup_at ? istDateTime(s.last_backup_at) : 'not yet'}`
                    : 'We write three files to one folder: all transactions, this month’s transactions and customers. We can see only the files we create.'}
                </p>
              </div>
            </div>
            {s.last_error && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>Last backup failed: {s.last_error}</AlertDescription>
              </Alert>
            )}
            {s.connected ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium" id="auto-label">
                      Daily automatic backup
                    </p>
                    <p className="text-muted-foreground text-xs">Once a day, while your plan includes backup.</p>
                  </div>
                  <Switch aria-labelledby="auto-label" checked={s.auto_backup} disabled={busy === 'auto' || !s.included_in_plan} onCheckedChange={(v) => void setAuto(v)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button className="h-11" disabled={Boolean(busy) || !s.included_in_plan} onClick={() => void backup()}>
                    {busy === 'backup' ? <Loader2 className="animate-spin" /> : <CloudUpload />} Back up now
                  </Button>
                  {s.folder_url && (
                    <Button variant="outline" className="h-11" asChild>
                      <a href={s.folder_url} target="_blank" rel="noopener noreferrer">
                        <FolderOpen /> Open folder <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  )}
                  <Button variant="ghost" className="text-muted-foreground hover:text-destructive h-11" disabled={Boolean(busy)} onClick={() => setConfirm(true)}>
                    <Unplug /> Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <Button className="h-11" disabled={Boolean(busy) || !s.included_in_plan} onClick={() => void connect()}>
                {busy === 'connect' ? <Loader2 className="animate-spin" /> : <CloudUpload />} Connect Google Drive
              </Button>
            )}
          </section>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect Google Drive?"
        description="Backups stop. Files already in your Drive stay there."
        confirmLabel="Disconnect"
        destructive
        pending={busy === 'disconnect'}
        onConfirm={() => void disconnect()}
      />
    </>
  );
}
