'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { formatMinor } from '@pay2all/ui/lib/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ApprovalPolicy, EffectiveLimits } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const FIELDS: { key: string; label: string; amount: boolean }[] = [
  { key: 'per_transaction_min', label: 'Per transaction min', amount: true },
  { key: 'per_transaction_max', label: 'Per transaction max', amount: true },
  { key: 'daily_amount', label: 'Daily amount', amount: true },
  { key: 'daily_count', label: 'Daily count', amount: false },
  { key: 'monthly_amount', label: 'Monthly amount', amount: true },
  { key: 'monthly_count', label: 'Monthly count', amount: false },
];

const display = (v: string | number | null, amount: boolean) =>
  v === null ? 'No limit' : amount ? formatMinor(BigInt(String(v).replace('.', ''))) : Number(v).toLocaleString('en-IN');

type LimitTarget = { level: 'SYSTEM' } | { level: 'RESELLER' | 'MERCHANT'; subjectId: string };

/** Editor for one level's limits; blank = inherit from the level above. */
export function LimitsEditor({ target, service, current, onSaved }: { target: LimitTarget; service: 'PAYIN' | 'PAYOUT'; current: Record<string, string | number | null>; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, current[f.key] === null || current[f.key] === undefined ? '' : String(current[f.key])])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save() {
    setBusy(true);
    setErrors({});
    const body: Record<string, unknown> = { level: target.level, service, reason };
    if (target.level !== 'SYSTEM') body.subject_id = target.subjectId;
    for (const f of FIELDS) {
      const raw = values[f.key]?.trim() ?? '';
      body[f.key] = raw === '' ? null : f.amount ? raw : Number(raw);
    }
    try {
      await api.put('/v1/limits', body);
      toast.success(`${service} limits saved`);
      setReason('');
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`${service}-${f.key}`}>{f.label}{f.amount ? ' (₹)' : ''}</Label>
            <Input id={`${service}-${f.key}`} inputMode={f.amount ? 'decimal' : 'numeric'} placeholder="Inherit" value={values[f.key]} aria-invalid={Boolean(errors[f.key])} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            {errors[f.key] && <p className="text-destructive text-xs">{errors[f.key]}</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor={`${service}-reason`}>Reason for change (audited)</Label>
          <Input id={`${service}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button disabled={busy || reason.trim().length < 5} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save {service.toLowerCase()} limits</Button>
      </div>
    </div>
  );
}

/** Effective limits for a merchant with the source level of each value, plus a merchant-level editor. */
export function MerchantLimitsPanel({ merchantId }: { merchantId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const effective = useQuery({ queryKey: ['limits', 'effective', merchantId], queryFn: () => api.get<EffectiveLimits>('/v1/limits/effective', { merchant_id: merchantId }) });
  const own = useQuery({
    queryKey: ['limits', 'MERCHANT', merchantId],
    queryFn: () => api.get<(Record<string, string | number | null> & { service: 'PAYIN' | 'PAYOUT' })[]>('/v1/limits', { level: 'MERCHANT', subject_id: merchantId }),
    enabled: can('limit.manage'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['limits'] });

  if (effective.isPending) return <LoadingSkeleton />;
  if (effective.isError) return <ErrorState message={errorMessage(effective.error)} onRetry={() => void effective.refetch()} />;

  return (
    <div className="space-y-6">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Effective limits</CardTitle>
          <CardDescription>The most specific level wins for each field: merchant, then reseller, then system.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Limit</TableHead><TableHead>Payin</TableHead><TableHead>Payout</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {FIELDS.map((f) => (
                <TableRow key={f.key}>
                  <TableCell className="text-muted-foreground">{f.label}</TableCell>
                  {(['payin', 'payout'] as const).map((svc) => {
                    const v = effective.data[svc][f.key];
                    return (
                      <TableCell key={svc}>
                        <span className="tabular font-medium">{display(v?.value ?? null, f.amount)}</span>
                        {v?.source && <StatusBadge status={v.source} tone="neutral" className="ml-2" />}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {can('limit.manage') && own.data && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Merchant-level overrides</CardTitle>
            <CardDescription>Leave a field blank to inherit. Resellers can only tighten limits set above them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-8">
            {own.data.map((row) => (
              <div key={row.service}>
                <h4 className="mb-3 text-sm font-semibold">{row.service}</h4>
                <LimitsEditor target={{ level: 'MERCHANT', subjectId: merchantId }} service={row.service} current={row} onSaved={refresh} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type TierRow = { up_to: string; approvals_required: number };

const minorToMajor = (m: string) => `${m.slice(0, -2) || '0'}.${m.slice(-2).padStart(2, '0')}`;

/** Maker-checker tiers editor. The last tier is open-ended. */
export function ApprovalPolicyEditor({ level, subjectId, policy, onSaved }: { level: 'SYSTEM' | 'RESELLER' | 'MERCHANT'; subjectId?: string; policy: ApprovalPolicy | null; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(policy?.maker_checker_enabled ?? true);
  const [tiers, setTiers] = useState<TierRow[]>(
    policy?.tiers.map((t) => ({ up_to: t.up_to_minor === null ? '' : minorToMajor(t.up_to_minor), approvals_required: t.approvals_required })) ?? [{ up_to: '', approvals_required: 0 }],
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.put('/v1/approval-policies', {
        level,
        ...(subjectId ? { subject_id: subjectId } : {}),
        maker_checker_enabled: enabled,
        reason,
        tiers: tiers.map((t, i) => ({ up_to: i === tiers.length - 1 ? null : t.up_to, approvals_required: t.approvals_required })),
      });
      toast.success('Approval policy saved');
      setReason('');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
        <span>Maker-checker enabled <span className="text-muted-foreground block text-xs">The person who creates a payout can never approve it.</span></span>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </label>
      <div className="space-y-2">
        {tiers.map((t, i) => {
          const last = i === tiers.length - 1;
          const from = i === 0 ? '₹0' : `above ₹${tiers[i - 1]?.up_to || '…'}`;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground w-28">{from}</span>
              <span>up to</span>
              {last ? <span className="w-36 font-medium">no limit</span> : <Input className="w-36" inputMode="decimal" value={t.up_to} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, up_to: e.target.value } : x)))} aria-label={`Tier ${i + 1} upper bound`} />}
              <span>needs</span>
              <Input className="w-16" type="number" min={0} max={3} value={t.approvals_required} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, approvals_required: Number(e.target.value) } : x)))} aria-label={`Tier ${i + 1} approvals`} />
              <span>approver(s)</span>
              {tiers.length > 1 && <Button variant="ghost" size="icon" aria-label="Remove tier" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}><Trash2 /></Button>}
            </div>
          );
        })}
        <Button variant="outline" size="sm" onClick={() => setTiers([...tiers.slice(0, -1), { up_to: '', approvals_required: tiers[tiers.length - 1]?.approvals_required ?? 0 }, tiers[tiers.length - 1]!])}>
          <Plus /> Add tier
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor={`policy-reason-${level}`}>Reason for change (audited)</Label>
          <Input id={`policy-reason-${level}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button disabled={busy || reason.trim().length < 5} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save policy</Button>
      </div>
    </div>
  );
}
