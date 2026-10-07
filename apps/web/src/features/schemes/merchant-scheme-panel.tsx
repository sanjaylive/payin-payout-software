'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantPricing } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { EffectiveBadge } from './merchant-schemes';
import { ProviderNo, rupees, SCHEMES_KEY, ServiceTag, useSchemes, ValueBadge } from './shared';

const DEFAULT = '__default__';

/** Merchant detail → Pricing: what prices this merchant, and changing its scheme. */
export function MerchantSchemePanel({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const q = useQuery({ queryKey: ['merchant-pricing', merchantId], queryFn: () => api.get<MerchantPricing>(`/v1/schemes/merchants/${merchantId}`) });
  const schemes = useSchemes();
  const [target, setTarget] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) return <LoadingSkeleton rows={4} />;
  const d = q.data;
  const active = (schemes.data?.schemes ?? []).filter((s) => s.status === 'ACTIVE');
  const current = d.assigned?.id ?? DEFAULT;
  const choice = target ?? current;

  async function save() {
    setBusy(true);
    try {
      await api.post('/v1/schemes/assign', { scheme_id: choice === DEFAULT ? null : choice, target: 'MERCHANTS', merchant_ids: [merchantId], reason: reason.trim() });
      toast.success('Scheme changed — applies from the next transaction');
      await Promise.all([qc.invalidateQueries({ queryKey: ['merchant-pricing', merchantId] }), qc.invalidateQueries({ queryKey: SCHEMES_KEY })]);
      setTarget(null);
      setConfirming(false);
      setReason('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="h-fit shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Pricing scheme</CardTitle>
          <CardDescription>
            In effect: <EffectiveBadge source={d.effective.source} name={d.effective.name} />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={choice} onValueChange={setTarget} disabled={!can('pricing.manage')}>
            <SelectTrigger className="w-full" aria-label="Assigned scheme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>Default scheme{active.find((s) => s.is_default) ? ` (${active.find((s) => s.is_default)!.name})` : ''}</SelectItem>
              {active.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {d.has_reseller && <p className="text-muted-foreground text-xs">This merchant belongs to a reseller. Assigning a scheme replaces the reseller’s rate card, and the reseller earns no margin on it.</p>}
          {can('pricing.manage') && (
            <Button className="w-full" disabled={choice === current} onClick={() => setConfirming(true)}>
              Change scheme
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            {d.scheme ? d.scheme.name : 'Rates'}
            {d.scheme && (
              <Link href={`/admin/pricing/schemes/${d.scheme.id}`} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-normal">
                Open scheme <ExternalLink className="size-3" />
              </Link>
            )}
          </CardTitle>
          {d.scheme && <CardDescription>GST {d.scheme.tax_rate}% on charges</CardDescription>}
        </CardHeader>
        <CardContent>
          {!d.scheme ? (
            <p className="text-muted-foreground text-sm">{d.effective.source === 'RATE_CARD' ? `Priced by the rate card “${d.effective.name}”. See Pricing → Rate cards.` : 'No pricing applies — this merchant’s transactions would be refused.'}</p>
          ) : d.scheme.rates.length === 0 ? (
            <p className="text-muted-foreground text-sm">This scheme has no rates yet.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {d.scheme.rates.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <ProviderNo id={r.provider_id} />
                  <span className="font-medium">{r.provider_name}</span>
                  <ServiceTag service={r.service} />
                  <span className="text-muted-foreground tabular-nums">{r.max_amount === null ? `${rupees(r.min_amount)} and above` : `${rupees(r.min_amount)} – ${rupees(r.max_amount)}`}</span>
                  <span className="ml-auto">
                    <ValueBadge type={r.type} value={r.value} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change this merchant’s scheme?</DialogTitle>
              <DialogDescription>Applies from the next transaction. Fees already charged don’t change.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="ms-reason">Reason (recorded in the audit log)</Label>
              <Textarea id="ms-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button disabled={busy || reason.trim().length < 5} onClick={() => void save()}>
                {busy && <Loader2 className="size-4 animate-spin" />} Change scheme
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
