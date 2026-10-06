'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { useQuery } from '@tanstack/react-query';
import { Percent, Receipt, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import type { FeeSummary } from '@/lib/api/types';
import { useMe } from '@/lib/auth/use-me';

export default function FeesPage() {
  const { data: me } = useMe();
  const merchantId = me?.organization.type === 'MERCHANT' ? me.organization.id : undefined;
  const [month, setMonth] = useState(() => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7));
  const q = useQuery({ queryKey: ['fees', merchantId, month], queryFn: () => api.get<FeeSummary>(`/v1/settlements/fees/${merchantId}`, { month }), enabled: Boolean(merchantId) });
  const f = q.data;
  return (
    <>
      <PageHeader title="Fees" description="What Pay2All charged you each month, with GST. Fees are deducted at the time of each transaction." actions={<Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" aria-label="Month" />} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Fees" value={f ? fmt(f.total_fees) : '—'} loading={q.isPending} icon={Receipt} />
        <StatCard label="GST on fees" value={f ? fmt(f.total_gst) : '—'} loading={q.isPending} icon={Percent} />
        <StatCard label="Refunded to customers" value={f ? fmt(f.refunds.amount) : '—'} loading={q.isPending} icon={Undo2} hint={f ? `${f.refunds.count} refunds` : undefined} />
      </div>
      <Card className="mt-6 shadow-none">
        <CardHeader><CardTitle className="text-base">Breakdown for {month}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Service</TableHead><TableHead className="text-right">Transactions</TableHead><TableHead className="text-right">Volume</TableHead><TableHead className="text-right">Fees</TableHead><TableHead className="text-right">GST</TableHead></TableRow></TableHeader>
            <TableBody>
              {f && (
                <>
                  <TableRow><TableCell>Payins (captured)</TableCell><TableCell className="tabular text-right">{f.payin.count}</TableCell><TableCell className="tabular text-right">{fmt(f.payin.volume)}</TableCell><TableCell className="tabular text-right">{fmt(f.payin.fees)}</TableCell><TableCell className="tabular text-right">{fmt(f.payin.gst)}</TableCell></TableRow>
                  <TableRow><TableCell>Payouts (completed)</TableCell><TableCell className="tabular text-right">{f.payout.count}</TableCell><TableCell className="tabular text-right">{fmt(f.payout.volume)}</TableCell><TableCell className="tabular text-right">{fmt(f.payout.fees)}</TableCell><TableCell className="tabular text-right">{fmt(f.payout.gst)}</TableCell></TableRow>
                  <TableRow className="font-medium"><TableCell>Total charged</TableCell><TableCell /><TableCell /><TableCell className="tabular text-right">{fmt(f.total_fees)}</TableCell><TableCell className="tabular text-right">{fmt(f.total_gst)}</TableCell></TableRow>
                </>
              )}
            </TableBody>
          </Table>
          <p className="text-muted-foreground mt-3 text-xs">GST invoices are issued with monthly reports (coming with Reports).</p>
        </CardContent>
      </Card>
    </>
  );
}
