'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/page-header';
import { ApprovalPolicyEditor, LimitsEditor } from '@/features/merchants/limits-panel';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ApprovalPolicy } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

type LimitRow = Record<string, string | number | null> & { service: 'PAYIN' | 'PAYOUT'; version: number };

export default function SystemLimitsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const limits = useQuery({ queryKey: ['limits', 'SYSTEM'], queryFn: () => api.get<LimitRow[]>('/v1/limits', { level: 'SYSTEM' }) });
  const policy = useQuery({ queryKey: ['approval-policy', 'SYSTEM'], queryFn: () => api.get<ApprovalPolicy | null>('/v1/approval-policies', { level: 'SYSTEM' }) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['limits'] }).then(() => qc.invalidateQueries({ queryKey: ['approval-policy'] }));

  if (limits.isPending || policy.isPending) return <LoadingSkeleton rows={8} />;
  if (limits.isError) return <ErrorState message={errorMessage(limits.error)} />;

  return (
    <>
      <PageHeader title="Limits & approvals" description="Platform defaults. Reseller and merchant levels can only tighten them." />
      <div className="space-y-6">
        {limits.data.map((row) => (
          <Card key={`${row.service}-${row.version}`} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">System {row.service.toLowerCase()} limits</CardTitle>
              <CardDescription>Applies to every merchant unless overridden at a more specific level.</CardDescription>
            </CardHeader>
            <CardContent>
              {can('limit.manage') ? <LimitsEditor target={{ level: 'SYSTEM' }} service={row.service} current={row} onSaved={refresh} /> : <pre className="text-xs">{JSON.stringify(row, null, 2)}</pre>}
            </CardContent>
          </Card>
        ))}
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Payout maker-checker policy</CardTitle>
            <CardDescription>How many independent approvers a payout needs, by amount.</CardDescription>
          </CardHeader>
          <CardContent>
            {can('approval_policy.manage') ? (
              <ApprovalPolicyEditor key={JSON.stringify(policy.data)} level="SYSTEM" policy={policy.data ?? null} onSaved={refresh} />
            ) : (
              <p className="text-muted-foreground text-sm">You can view but not change this policy.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
