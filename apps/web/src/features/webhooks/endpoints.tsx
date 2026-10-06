'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { EmptyState, ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { MERCHANT_EVENT_TYPES } from '@pay2all/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Loader2, Plus, Send, Webhook } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { WebhookEndpointRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

/** Shown once after create / rotate; the secret can never be retrieved again. */
function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your signing secret</DialogTitle>
          <DialogDescription>Copy it now and store it in your server’s secret manager. For your security it will not be shown again.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded-md px-3 py-2 font-mono text-xs break-all">{secret}</code>
          <Button size="icon" variant="outline" aria-label="Copy secret" onClick={() => secret && void navigator.clipboard.writeText(secret).then(() => toast.success('Secret copied'))}><Copy /></Button>
        </div>
        <p className="text-muted-foreground text-xs">Verify every request: compute HMAC-SHA256 of <code>{'<t>.<raw body>'}</code> with this secret and compare it to the <code>v1</code> value in the <code>Pay2All-Signature</code> header. Reject timestamps older than 5 minutes.</p>
        <DialogFooter><Button onClick={onClose}>I’ve stored it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndpointDialog({ endpoint, open, onOpenChange, onSecret }: { endpoint?: WebhookEndpointRow; open: boolean; onOpenChange: (o: boolean) => void; onSecret: (s: string) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [all, setAll] = useState(!endpoint || endpoint.events.length === 0);
  const [events, setEvents] = useState<string[]>(endpoint?.events ?? []);
  const [busy, setBusy] = useState(false);
  const valid = /^https?:\/\/.+/.test(url.trim()) && (all || events.length > 0);
  async function save() {
    setBusy(true);
    try {
      const body = { url: url.trim(), description: description.trim() || (endpoint ? null : undefined), events: all ? [] : events };
      if (endpoint) {
        await api.patch(`/v1/webhooks/endpoints/${endpoint.endpoint_id}`, body);
        toast.success('Endpoint updated');
      } else {
        const created = await api.post<WebhookEndpointRow>('/v1/webhooks/endpoints', body);
        if (created.secret) onSecret(created.secret);
      }
      await qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{endpoint ? 'Edit endpoint' : 'Add webhook endpoint'}</DialogTitle>
          <DialogDescription>We POST signed JSON events to this URL and retry for up to 2 days if it doesn’t answer 2xx.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="wh-url">Endpoint URL</Label><Input id="wh-url" placeholder="https://example.com/webhooks/pay2all" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="wh-desc">Description (optional)</Label><Input id="wh-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={all} onCheckedChange={(v) => setAll(v === true)} /> All events, including ones added later</label>
            {!all && (
              <div className="grid grid-cols-2 gap-1.5 rounded-md border p-3">
                {MERCHANT_EVENT_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox checked={events.includes(t)} onCheckedChange={(v) => setEvents((cur) => (v === true ? [...cur, t] : cur.filter((x) => x !== t)))} />
                    {t}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} {endpoint ? 'Save' : 'Add endpoint'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WebhookEndpoints() {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('webhook.manage');
  const endpoints = useQuery({ queryKey: ['webhook-endpoints'], queryFn: () => api.get<WebhookEndpointRow[]>('/v1/webhooks/endpoints') });
  const [editing, setEditing] = useState<WebhookEndpointRow | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<WebhookEndpointRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(e: WebhookEndpointRow, what: 'test' | 'toggle' | 'rotate') {
    setBusy(e.endpoint_id + what);
    try {
      if (what === 'test') {
        await api.post(`/v1/webhooks/endpoints/${e.endpoint_id}/test`);
        toast.success('Test event queued — check the webhook log in a few seconds');
      } else if (what === 'toggle') {
        await api.patch(`/v1/webhooks/endpoints/${e.endpoint_id}`, { status: e.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
        toast.success(e.status === 'ACTIVE' ? 'Endpoint disabled' : 'Endpoint enabled');
      } else {
        const r = await api.post<WebhookEndpointRow>(`/v1/webhooks/endpoints/${e.endpoint_id}/rotate-secret`);
        setRotating(null);
        if (r.secret) setSecret(r.secret);
      }
      await qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (endpoints.isPending) return <LoadingSkeleton rows={3} />;
  if (endpoints.error) return <ErrorState message={errorMessage(endpoints.error)} onRetry={() => void endpoints.refetch()} />;
  return (
    <div className="space-y-4">
      {manage && <div className="flex justify-end"><Button onClick={() => setEditing('new')}><Plus /> Add endpoint</Button></div>}
      {endpoints.data.length === 0 ? (
        <EmptyState icon={Webhook} title="No webhook endpoints" description="Add an endpoint to receive payment, refund and payout events in real time." action={manage ? <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add endpoint</Button> : undefined} />
      ) : (
        endpoints.data.map((e) => (
          <Card key={e.endpoint_id} className="shadow-none">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base"><span className="font-mono text-sm break-all">{e.url}</span><StatusBadge status={e.status} /></CardTitle>
              <CardDescription>
                {e.description ? `${e.description} · ` : ''}Secret {e.secret_hint}{e.previous_secret_valid_until ? ` (old secret also signs until ${formatDateTime(e.previous_secret_valid_until)})` : ''} · {e.last_success_at ? `last delivered ${formatRelative(e.last_success_at)}` : 'no successful delivery yet'} · added {formatDateTime(e.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {e.disabled_reason && (
                <Alert variant={e.disabled_reason.startsWith('Auto') ? 'destructive' : undefined}>
                  <AlertTitle>Disabled</AlertTitle>
                  <AlertDescription>{e.disabled_reason}. Fix the endpoint, enable it, then replay failed deliveries from the webhook log.</AlertDescription>
                </Alert>
              )}
              {e.consecutive_failures > 0 && e.status === 'ACTIVE' && <p className="text-warning-foreground dark:text-warning text-xs">{e.consecutive_failures} failed attempts in a row — the endpoint is disabled automatically at 100.</p>}
              <div className="flex flex-wrap gap-1">
                {(e.events.length ? e.events : ['all events']).map((t) => <span key={t} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">{t}</span>)}
              </div>
              {manage && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(e)}>Edit</Button>
                  <Button size="sm" variant="outline" disabled={e.status !== 'ACTIVE' || busy !== null} onClick={() => void act(e, 'test')}><Send /> Send test event</Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setRotating(e)}><KeyRound /> Rotate secret</Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(e, 'toggle')}>{e.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
      {editing && <EndpointDialog key={editing === 'new' ? 'new' : editing.endpoint_id} endpoint={editing === 'new' ? undefined : editing} open onOpenChange={(o) => !o && setEditing(null)} onSecret={setSecret} />}
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={Boolean(rotating)}
        onOpenChange={(o) => !o && setRotating(null)}
        title="Rotate the signing secret?"
        description="Deliveries are signed with both the old and the new secret for 24 hours, so you can update your server without dropping events. After that only the new secret signs."
        confirmLabel="Rotate"
        destructive
        pending={busy !== null}
        onConfirm={() => rotating && void act(rotating, 'rotate')}
      />
    </div>
  );
}
