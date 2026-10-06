'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, CircleAlert, Clock, FileWarning, Gauge, Hourglass, Landmark, Wallet } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';

const CARDS = [
  { label: 'Total Payin', icon: ArrowDownToLine, phase: 5 },
  { label: 'Total Payout', icon: ArrowUpFromLine, phase: 6 },
  { label: 'Total Revenue', icon: Banknote, phase: 5 },
  { label: 'Total Merchant Balance', icon: Wallet, phase: 3 },
  { label: 'Unsettled Amount', icon: Hourglass, phase: 3 },
  { label: 'Settlement Due', icon: Landmark, phase: 8 },
  { label: 'Failed Transactions', icon: CircleAlert, phase: 5 },
  { label: 'Pending Compliance', icon: FileWarning, phase: 2 },
  { label: 'Provider Health', icon: Gauge, phase: 4 },
  { label: 'Transactions / sec', icon: Clock, phase: 10 },
];

export default function AdminDashboard() {
  return (
    <>
      <PageHeader title="Platform overview" description="Pay2All Payments operations console." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {CARDS.map((c) => (
          <StatCard key={c.label} label={c.label} value="—" icon={c.icon} hint={`Live from Phase ${c.phase}`} />
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {[
          { title: 'Merchants', body: 'Create merchant shells, suspend or reactivate accounts.', href: '/admin/merchants' },
          { title: 'Users & Roles', body: 'Platform staff, tenant members and the permission matrix.', href: '/admin/users' },
          { title: 'Audit Logs', body: 'Immutable trail of every privileged action and sign-in.', href: '/admin/audit-logs' },
        ].map((q) => (
          <Link key={q.href} href={q.href} className="group">
            <Card className="group-hover:border-primary/40 h-full shadow-none transition-colors">
              <CardHeader>
                <CardTitle className="text-base">{q.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">{q.body}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
