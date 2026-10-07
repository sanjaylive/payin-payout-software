'use client';

import { PageHeader } from '@/components/common/page-header';
import { ReportExports } from '@/features/reports/report-exports';

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Export your payins, refunds, payouts and settlements. Files are generated in the background and kept for 7 days." />
      <ReportExports />
    </>
  );
}
