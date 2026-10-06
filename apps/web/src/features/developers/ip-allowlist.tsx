'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { IpAllowlist as Allowlist } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

export function IpAllowlist() {
  const can = useCan();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['ip-allowlist'], queryFn: () => api.get<Allowlist>('/v1/developers/ip-allowlist') });
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const manage = can('api_key.manage');
  async function add() {
    setBusy(true);
    try {
      await api.post('/v1/developers/ip-allowlist', { cidr: cidr.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
      setCidr('');
      setLabel('');
      await qc.invalidateQueries({ queryKey: ['ip-allowlist'] });
      toast.success('Address added');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api.delete(`/v1/developers/ip-allowlist/${id}`);
      await qc.invalidateQueries({ queryKey: ['ip-allowlist'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  const d = list.data;
  return (
    <div className="space-y-4">
      {d && (
        <Alert variant={d.enforced ? undefined : 'default'}>
          {d.enforced ? <ShieldCheck /> : <ShieldOff />}
          <AlertTitle>{d.enforced ? 'Allowlist enforced' : 'Not enforced'}</AlertTitle>
          <AlertDescription>{d.enforced ? `API calls (${d.environment}) are accepted only from the addresses below. Signatures are still required.` : 'API calls are accepted from any address. Add your servers’ public IPs to restrict them — strongly recommended for live keys.'}</AlertDescription>
        </Alert>
      )}
      {manage && (
        <div className="flex flex-wrap gap-2">
          <Input className="w-60 font-mono" placeholder="203.0.113.10 or 203.0.113.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} aria-label="IP or CIDR" />
          <Input className="w-56" placeholder="Label (e.g. Prod server 1)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
          <Button disabled={!cidr.trim() || busy} onClick={() => void add()}><Plus /> Add address</Button>
        </div>
      )}
      <DataTable
        rows={d?.entries}
        loading={list.isFetching}
        error={toTableError(list.error)}
        rowKey={(e) => e.entry_id}
        empty={{ title: 'No addresses' }}
        columns={[
          { id: 'cidr', header: 'Address', cell: (e) => <span className="font-mono text-sm">{e.cidr}</span> },
          { id: 'label', header: 'Label', cell: (e) => <span className="text-sm">{e.label ?? '—'}</span> },
          { id: 'added', header: 'Added', cell: (e) => <span className="text-sm">{formatDateTime(e.created_at)}</span> },
          { id: 'del', header: '', align: 'right', cell: (e) => (manage ? <Button size="icon" variant="ghost" aria-label={`Remove ${e.cidr}`} onClick={() => void remove(e.entry_id)}><Trash2 /></Button> : null) },
        ]}
      />
    </div>
  );
}
