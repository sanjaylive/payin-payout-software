'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { API_KEY_PERMISSIONS } from '@pay2all/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ApiKeyRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const PERMISSION_LABEL: Record<string, string> = {
  'payin.create': 'Create payments',
  'payin.read': 'Read payments',
  'payin.refund': 'Refund payments',
  'payout.create': 'Create payouts',
  'payout.read': 'Read payouts',
  'beneficiary.read': 'Read beneficiaries',
  'beneficiary.manage': 'Manage beneficiaries',
  'settlement.read': 'Read settlements',
  'ledger.read': 'Read balances',
};

const copy = (v: string, what: string) => void navigator.clipboard.writeText(v).then(() => toast.success(`${what} copied`));

function SecretReveal({ k, onClose }: { k: ApiKeyRow | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(k?.secret)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Your API key</DialogTitle>
          <DialogDescription>Store the secret in your server’s secret manager now. It will not be shown again; if you lose it, rotate the key.</DialogDescription>
        </DialogHeader>
        {k && (
          <div className="space-y-3">
            {[['Key ID (X-Pay2All-Key)', k.public_key], ['Secret (never send it; sign with it)', k.secret!]].map(([label, v]) => (
              <div key={label} className="space-y-1">
                <Label>{label}</Label>
                <div className="flex gap-2"><code className="bg-muted flex-1 rounded-md px-3 py-2 font-mono text-xs break-all">{v}</code><Button size="icon" variant="outline" aria-label={`Copy ${label}`} onClick={() => copy(v!, label!)}><Copy /></Button></div>
              </div>
            ))}
            <p className="text-muted-foreground text-xs">Every request carries a timestamp, a fresh nonce and an HMAC signature — see the <Link className="text-primary hover:underline" href="/developers/docs">API documentation</Link> for code samples.</p>
          </div>
        )}
        <DialogFooter><Button onClick={onClose}>I’ve stored it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (k: ApiKeyRow) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const grantable = API_KEY_PERMISSIONS.filter((p) => can(p));
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<string[]>(grantable);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const k = await api.post<ApiKeyRow>('/v1/developers/api-keys', { name: name.trim(), permissions: perms });
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
      onOpenChange(false);
      setName('');
      onCreated(k);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Give each server or integration its own key with only the permissions it needs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="key-name">Name</Label><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout server" /></div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Permissions</legend>
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
              {grantable.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm"><Checkbox checked={perms.includes(p)} onCheckedChange={(v) => setPerms((c) => (v === true ? [...c, p] : c.filter((x) => x !== p)))} />{PERMISSION_LABEL[p] ?? p}</label>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">Approving payouts, team and settings are never available to API keys.</p>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={name.trim().length < 2 || !perms.length || busy} onClick={() => void create()}>{busy && <Loader2 className="animate-spin" />} Create key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeys() {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('api_key.manage');
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKeyRow[]>('/v1/developers/api-keys') });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<ApiKeyRow | null>(null);
  const [action, setAction] = useState<{ k: ApiKeyRow; kind: 'rotate' | 'revoke' } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === 'rotate') setRevealed(await api.post<ApiKeyRow>(`/v1/developers/api-keys/${action.k.key_id}/rotate`, { overlap_hours: 24 }));
      else {
        await api.post(`/v1/developers/api-keys/${action.k.key_id}/revoke`);
        toast.success('Key revoked');
      }
      setAction(null);
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const env = keys.data?.[0]?.environment;
  return (
    <div className="space-y-4">
      {env === 'TEST' && <Alert><KeyRound /><AlertDescription>These are <strong>test</strong> keys for the sandbox: they move no real money. Live keys are issued in the live environment after go-live review.</AlertDescription></Alert>}
      <DataTable
        rows={keys.data}
        loading={keys.isFetching}
        error={toTableError(keys.error)}
        rowKey={(k) => k.key_id}
        empty={{ title: 'No API keys yet', description: 'Create a key to call the Pay2All API from your server.', action: manage ? <Button size="sm" onClick={() => setCreating(true)}><Plus /> Create key</Button> : undefined }}
        toolbar={manage ? <div className="flex w-full justify-end"><Button onClick={() => setCreating(true)}><Plus /> Create key</Button></div> : undefined}
        columns={[
          { id: 'name', header: 'Key', cell: (k) => <div><p className="font-medium">{k.name}</p><p className="text-muted-foreground font-mono text-xs">{k.public_key}</p><p className="text-muted-foreground font-mono text-[11px]">{k.secret_hint}</p></div> },
          { id: 'perms', header: 'Permissions', cell: (k) => <div className="flex max-w-xs flex-wrap gap-1">{k.permissions.map((p) => <span key={p} className="bg-muted rounded px-1.5 py-0.5 text-[11px]">{PERMISSION_LABEL[p] ?? p}</span>)}</div> },
          { id: 'status', header: 'Status', cell: (k) => <div className="space-y-0.5"><StatusBadge status={k.status} />{k.status === 'ACTIVE' && k.expires_at && <p className="text-warning-foreground dark:text-warning text-[11px]">Rotated · works until {formatDateTime(k.expires_at)}</p>}</div> },
          { id: 'used', header: 'Last used', cell: (k) => <span className="text-sm">{k.last_used_at ? `${formatRelative(k.last_used_at)}${k.last_used_ip ? ` from ${k.last_used_ip}` : ''}` : 'Never'}</span> },
          { id: 'limit', header: 'Limit', align: 'right', cell: (k) => <span className="tabular text-sm">{k.rate_limit_per_minute}/min</span> },
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (k) =>
              manage && k.status === 'ACTIVE' ? (
                <div className="flex justify-end gap-1">
                  {!k.expires_at && <Button size="sm" variant="outline" onClick={() => setAction({ k, kind: 'rotate' })}><RefreshCw /> Rotate</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setAction({ k, kind: 'revoke' })}>Revoke</Button>
                </div>
              ) : null,
          },
        ]}
      />
      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={setRevealed} />
      <SecretReveal k={revealed} onClose={() => setRevealed(null)} />
      <ConfirmDialog
        open={Boolean(action)}
        onOpenChange={(o) => !o && setAction(null)}
        title={action?.kind === 'rotate' ? 'Rotate this key?' : 'Revoke this key?'}
        description={action?.kind === 'rotate' ? 'A new key and secret are issued now. The current key keeps working for 24 hours so you can deploy the new one.' : 'Requests signed with this key fail immediately. This cannot be undone.'}
        confirmLabel={action?.kind === 'rotate' ? 'Rotate' : 'Revoke'}
        destructive={action?.kind === 'revoke'}
        pending={busy}
        onConfirm={() => void run()}
      />
    </div>
  );
}
