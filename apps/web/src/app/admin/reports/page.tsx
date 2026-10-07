'use client';

import { PageHeader } from '@/components/common/page-header';
import { ReportExports } from '@/features/reports/report-exports';

export default function AdminReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Platform-wide exports of payins, refunds, payouts and settlements, optionally for one merchant." />
      <ReportExports allowMerchantFilter />
    </>
  );
}
