'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useInvalidateMerchant } from './use-merchant';

const OPTIONS = ['NOT_STARTED', 'PENDING', 'CLEAR', 'MATCH_FOUND', 'FALSE_POSITIVE'];
const FIELDS = [
  ['sanctions_status', 'Sanctions'],
  ['pep_status', 'Politically exposed persons (PEP)'],
  ['adverse_media_status', 'Adverse media'],
] as const;

/** Screening results are recorded manually until screening-provider integrations land. */
export function ScreeningPanel({ app }: { app: MerchantApplication }) {
  const can = useCan();
  const invalidate = useInvalidateMerchant(app.id);
  const s = app.screening;
  const [values, setValues] = useState<Record<string, string>>({
    sanctions_status: s?.sanctions_status ?? 'NOT_STARTED',
    pep_status: s?.pep_status ?? 'NOT_STARTED',
    adverse_media_status: s?.adverse_media_status ?? 'NOT_STARTED',
    risk_category: app.risk_category ?? '',
  });
  const [notes, setNotes] = useState(s?.risk_notes ?? '');
  const [busy, setBusy] = useState(false);
  const editable = can('compliance.approve') && !['DRAFT', 'REJECTED'].includes(app.status);

  async function save() {
    setBusy(true);
    try {
      const { risk_category, ...rest } = values;
      await api.patch(`/v1/merchants/${app.id}/screening`, { ...rest, ...(risk_category ? { risk_category } : {}), notes });
      toast.success('Screening recorded');
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Screening and risk</CardTitle>
        <CardDescription>{s?.screened_at ? `Last screened ${formatDateTime(s.screened_at)}` : 'Not screened yet'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label>{label}</Label>
            {editable ? (
              <Select value={values[key]} onValueChange={(v) => setValues({ ...values, [key]: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{OPTIONS.map((o) => <SelectItem key={o} value={o}>{o.replaceAll('_', ' ')}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <div><StatusBadge status={values[key] ?? 'NOT_STARTED'} /></div>
            )}
          </div>
        ))}
        <div className="space-y-1.5">
          <Label>Risk category</Label>
          {editable ? (
            <Select value={values.risk_category} onValueChange={(v) => setValues({ ...values, risk_category: v })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Not assessed" /></SelectTrigger>
              <SelectContent><SelectItem value="LOW">Low</SelectItem><SelectItem value="MEDIUM">Medium</SelectItem><SelectItem value="HIGH">High</SelectItem></SelectContent>
            </Select>
          ) : (
            <div>{app.risk_category ? <StatusBadge status={app.risk_category} /> : '—'}</div>
          )}
        </div>
        {s?.risk_notes !== undefined && (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="risk-notes">Internal risk notes (never shown to the merchant)</Label>
            <Textarea id="risk-notes" rows={3} value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}
        {editable && (
          <div className="md:col-span-2">
            <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save screening</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
