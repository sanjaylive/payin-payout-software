'use client';

import { PageHeader } from '@/components/common/page-header';
import { BulkPayouts } from '@/features/payout/bulk-payouts';

export default function BulkPayoutPage() {
  return (
    <>
      <PageHeader title="Bulk payout" description="Pay many beneficiaries at once from a CSV — salaries, vendor runs, refunds." />
      <BulkPayouts />
    </>
  );
}
