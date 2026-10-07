'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatRelative } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History, KeyRound, Link2, Loader2, Pencil, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ApiVendor, MessagingServiceRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { ADAPTER_LABELS, SERVICE_LABELS } from './labels';
import { CredentialsDialog, MessagingServiceDialog, RecentMessagesDrawer, TestMessageDialog } from './messaging-dialogs';

interface ProviderOption { id: string; code: string; name: string; kind: string; vendor_id: string | null }
interface AdapterOption { key: string; label: string; payin: boolean; payout: boolean }

function AddPaymentServiceDialog({ vendor, open, onClose }: { vendor: ApiVendor; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const adapters = useQuery({ queryKey: ['provider-adapters'], queryFn: () => api.get<AdapterOption[]>('/v1/providers/adapters'), enabled: open });
  const [kind, setKind] = useState<'PAYIN' | 'PAYOUT' | 'BOTH'>('PAYOUT');
  const [adapter, setAdapter] = useState('');
  const [name, setName] = useState(`${vendor.name} payouts`);
  const [code, setCode] = useState(`${vendor.code}-payout`);
  const [busy, setBusy] = useState(false);
  const usable = (adapters.data ?? []).filter((a) => (kind !== 'PAYOUT' ? a.payin : true) && (kind !== 'PAYIN' ? a.payout : true));
  async function submit() {
    setBusy(true);
    try {
      const p = await api.post<{ id: string }>('/v1/providers', { code, name, kind, adapter, environment: 'TEST', vendor_id: vendor.vendor_id });
      await qc.invalidateQueries({ queryKey: ['vendor', vendor.vendor_id] });
      toast.success('Payment service added (disabled) — set its credentials and test it');
      router.push(`/admin/providers/${p.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add payment service</DialogTitle>
          <DialogDescription>Pick the integration built for this vendor. A new bank needs its integration coded from the bank’s API document first — it then appears in this list.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Service</Label>
            <Select value={kind} onValueChange={(v) => { const k = v as typeof kind; setKind(k); setAdapter(''); setName(`${vendor.name} ${k === 'PAYIN' ? 'collections' : k === 'PAYOUT' ? 'payouts' : 'payin & payout'}`); setCode(`${vendor.code}-${k.toLowerCase()}`); }}>
              <SelectTrigger aria-label="Service"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="PAYIN">Payin (collections)</SelectItem><SelectItem value="PAYOUT">Payout</SelectItem><SelectItem value="BOTH">Payin and payout</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Integration</Label>
            <Select value={adapter} onValueChange={setAdapter}>
              <SelectTrigger aria-label="Integration"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>{usable.map((a) => <SelectItem key={a.key} value={a.key}>{a.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="ps-name">Name</Label><Input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="ps-code">Code</Label><Input id="ps-code" className="font-mono" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!adapter || name.trim().length < 2 || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(code) || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovePaymentServiceDialog({ vendor, open, onClose }: { vendor: ApiVendor; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers', 'all'], queryFn: () => api.get<ProviderOption[]>('/v1/providers'), enabled: open });
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const options = (providers.data ?? []).filter((p) => p.vendor_id !== vendor.vendor_id);
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/v1/vendors/${vendor.vendor_id}/payment-services`, { provider_id: providerId });
      await qc.invalidateQueries({ queryKey: ['vendor', vendor.vendor_id] });
      await qc.invalidateQueries({ queryKey: ['vendors'] });
      toast.success('Payment service moved');
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move a payment service here</DialogTitle>
          <DialogDescription>For a bank that offers both payin and payout: keep both services under one vendor. Routing and health are not affected.</DialogDescription>
        </DialogHeader>
        <Select value={providerId} onValueChange={setProviderId}>
          <SelectTrigger aria-label="Payment service"><SelectValue placeholder="Choose a payment service…" /></SelectTrigger>
          <SelectContent>{options.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} ({SERVICE_LABELS[p.kind] ?? 'Payin + payout'})</SelectItem>)}</SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!providerId || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Move</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VendorDetail({ id }: { id: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('provider.manage');
  const q = useQuery({ queryKey: ['vendor', id], queryFn: () => api.get<ApiVendor>(`/v1/vendors/${id}`) });
  const [dialog, setDialog] = useState<'add-payment' | 'move-payment' | 'add-messaging' | null>(null);
  const [editing, setEditing] = useState<MessagingServiceRow | null>(null);
  const [creds, setCreds] = useState<MessagingServiceRow | null>(null);
  const [testing, setTesting] = useState<MessagingServiceRow | null>(null);
  const [history, setHistory] = useState<MessagingServiceRow | null>(null);
  const v = q.data;

  async function toggleVendor() {
    if (!v) return;
    try {
      await api.patch(`/v1/vendors/${v.vendor_id}`, { status: v.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      await qc.invalidateQueries({ queryKey: ['vendor', id] });
      toast.success(v.status === 'ACTIVE' ? 'Vendor deactivated — its messaging services stop sending' : 'Vendor activated');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <Link href="/admin/settings/vendors" className="text-muted-foreground mb-2 inline-flex items-center gap-1 text-sm hover:underline"><ArrowLeft className="size-4" /> API vendors</Link>
      <PageHeader
        level={2}
        title={v?.name ?? 'Vendor'}
        description={v ? `${v.code}${v.website ? ` · ${v.website}` : ''}` : undefined}
        actions={v && manage ? <Button variant="outline" onClick={() => void toggleVendor()}>{v.status === 'ACTIVE' ? 'Deactivate vendor' : 'Activate vendor'}</Button> : undefined}
      />
      {v?.status === 'INACTIVE' && <Alert className="mb-4"><AlertDescription>This vendor is inactive: its messaging services are skipped by routing. Payment services keep their own status.</AlertDescription></Alert>}
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div><CardTitle className="text-base">Payment services</CardTitle><CardDescription>Payin and payout integrations. Credentials, health and status are managed on each service.</CardDescription></div>
            {v && manage && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setDialog('move-payment')}><Link2 /> Move here</Button><Button size="sm" onClick={() => setDialog('add-payment')}><Plus /> Add</Button></div>}
          </CardHeader>
          <CardContent>
            <DataTable
              rows={v?.payment_services}
              loading={q.isFetching}
              error={toTableError(q.error)}
              rowKey={(p) => p.provider_id}
              empty={{ title: 'No payment services', description: 'Share the vendor’s payin / payout API document to get its integration built.' }}
              columns={[
                { id: 'name', header: 'Service', cell: (p) => <Link className="font-medium hover:underline" href={`/admin/providers/${p.provider_id}`}>{p.name}</Link> },
                { id: 'kind', header: 'Type', cell: (p) => <span className="text-sm">{p.kind === 'BOTH' ? 'Payin + payout' : SERVICE_LABELS[p.kind]}</span> },
                { id: 'adapter', header: 'Integration', cell: (p) => <span className="font-mono text-xs">{p.adapter}</span> },
                { id: 'env', header: 'Environment', cell: (p) => <StatusBadge status={p.environment} tone={p.environment === 'LIVE' ? 'primary' : 'info'} /> },
                { id: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              ]}
            />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div><CardTitle className="text-base">Messaging services</CardTitle><CardDescription>SMS, WhatsApp and email. New services start off: add credentials, send a test, then switch on.</CardDescription></div>
            {v && manage && <Button size="sm" onClick={() => setDialog('add-messaging')}><Plus /> Add</Button>}
          </CardHeader>
          <CardContent>
            <DataTable
              rows={v?.messaging_services}
              loading={q.isFetching}
              rowKey={(m) => m.service_id}
              empty={{ title: 'No messaging services' }}
              columns={[
                { id: 'name', header: 'Service', cell: (m) => <div className="space-y-0.5"><p className="font-medium">{m.name}</p><p className="text-muted-foreground text-xs">{SERVICE_LABELS[m.channel]} · {ADAPTER_LABELS[m.adapter]}</p></div> },
                { id: 'prio', header: 'Priority', align: 'right', cell: (m) => <span className="tabular text-sm">{m.priority}</span> },
                { id: 'creds', header: 'Credentials', cell: (m) => (m.has_secret ? <span className="font-mono text-xs">{Object.entries(m.secret_fingerprints).map(([k, f]) => `${k} ${f}`).join(' · ')}</span> : <span className="text-muted-foreground text-sm">Not set</span>) },
                {
                  id: 'health',
                  header: 'Last send',
                  className: 'whitespace-normal',
                  cell: (m) => (
                    <div className="max-w-xs space-y-0.5 text-xs">
                      {m.last_success_at && <p>OK {formatRelative(m.last_success_at)}</p>}
                      {m.last_failure_at && <p className="text-destructive line-clamp-2">Failed {formatRelative(m.last_failure_at)}: {m.last_error}</p>}
                      {!m.last_success_at && !m.last_failure_at && <p className="text-muted-foreground">Never used</p>}
                    </div>
                  ),
                },
                { id: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
                {
                  id: 'actions',
                  header: '',
                  align: 'right',
                  cell: (m) => (
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" aria-label={`Recent messages for ${m.name}`} onClick={() => setHistory(m)}><History /></Button>
                      {manage && <Button size="icon" variant="ghost" aria-label={`Send a test through ${m.name}`} onClick={() => setTesting(m)}><Send /></Button>}
                      {manage && <Button size="icon" variant="ghost" aria-label={`Credentials for ${m.name}`} onClick={() => setCreds(m)}><KeyRound /></Button>}
                      {manage && <Button size="icon" variant="ghost" aria-label={`Edit ${m.name}`} onClick={() => setEditing(m)}><Pencil /></Button>}
                    </div>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
      </div>
      {v && <AddPaymentServiceDialog key={`ap-${dialog}`} vendor={v} open={dialog === 'add-payment'} onClose={() => setDialog(null)} />}
      {v && <MovePaymentServiceDialog key={`mp-${dialog}`} vendor={v} open={dialog === 'move-payment'} onClose={() => setDialog(null)} />}
      {v && <MessagingServiceDialog key={`am-${dialog}`} vendorId={v.vendor_id} service={null} open={dialog === 'add-messaging'} onClose={() => setDialog(null)} />}
      {v && editing && <MessagingServiceDialog key={`em-${editing.service_id}`} vendorId={v.vendor_id} service={editing} open onClose={() => setEditing(null)} />}
      <CredentialsDialog key={`c-${creds?.service_id}`} service={creds} onClose={() => setCreds(null)} />
      <TestMessageDialog key={`t-${testing?.service_id}`} service={testing} onClose={() => setTesting(null)} />
      <RecentMessagesDrawer service={history} onClose={() => setHistory(null)} />
    </>
  );
}
