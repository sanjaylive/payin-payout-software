'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ApiVendor } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { SERVICE_LABELS } from './labels';

function CreateVendorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const suggested = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const effectiveCode = code || suggested;
  const valid = name.trim().length >= 2 && /^[a-z0-9][a-z0-9-]{1,39}$/.test(effectiveCode) && (!website || website.startsWith('https://'));
  async function submit() {
    setBusy(true);
    try {
      const v = await api.post<ApiVendor>('/v1/vendors', { name: name.trim(), code: effectiveCode, ...(website ? { website } : {}) });
      await qc.invalidateQueries({ queryKey: ['vendors'] });
      toast.success('Vendor added');
      router.push(`/admin/settings/vendors/${v.vendor_id}`);
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
          <DialogTitle>Add API vendor</DialogTitle>
          <DialogDescription>A company you integrate with — a bank, an SMS gateway or an email service. Add its services on the next screen.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="v-name">Name</Label><Input id="v-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="IDFC FIRST Bank" /></div>
          <div className="space-y-1.5"><Label htmlFor="v-code">Code</Label><Input id="v-code" className="font-mono" value={effectiveCode} onChange={(e) => setCode(e.target.value.toLowerCase())} /><p className="text-muted-foreground text-xs">Lowercase letters, digits and hyphens. Can’t be changed later.</p></div>
          <div className="space-y-1.5"><Label htmlFor="v-web">Website (optional)</Label><Input id="v-web" value={website} onChange={(e) => setWebsite(e.target.value.trim())} placeholder="https://" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Add vendor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VendorsList() {
  const can = useCan();
  const router = useRouter();
  const q = useQuery({ queryKey: ['vendors'], queryFn: () => api.get<ApiVendor[]>('/v1/vendors') });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <DataTable
        rows={q.data}
        loading={q.isFetching}
        error={toTableError(q.error)}
        rowKey={(v) => v.vendor_id}
        onRowClick={(v) => router.push(`/admin/settings/vendors/${v.vendor_id}`)}
        empty={{ title: 'No vendors yet' }}
        toolbar={can('provider.manage') ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add vendor</Button> : undefined}
        columns={[
          { id: 'name', header: 'Vendor', cell: (v) => <div className="space-y-0.5"><p className="font-medium">{v.name}</p><p className="text-muted-foreground font-mono text-[11px]">{v.code}</p></div> },
          {
            id: 'services',
            header: 'Services',
            className: 'whitespace-normal',
            cell: (v) => (v.services.length ? <div className="flex flex-wrap gap-1">{v.services.map((s) => <StatusBadge key={s} status={SERVICE_LABELS[s] ?? s} tone="info" />)}</div> : <span className="text-muted-foreground text-sm">None yet</span>),
          },
          {
            id: 'live',
            header: 'Active',
            cell: (v) => {
              const active = v.payment_services.filter((p) => p.status === 'ACTIVE').length + v.messaging_services.filter((m) => m.status === 'ACTIVE').length;
              const total = v.payment_services.length + v.messaging_services.length;
              return <span className="tabular text-sm">{active} / {total}</span>;
            },
          },
          { id: 'status', header: 'Status', cell: (v) => <StatusBadge status={v.status} /> },
        ]}
      />
      <CreateVendorDialog key={adding ? 'open' : 'closed'} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
