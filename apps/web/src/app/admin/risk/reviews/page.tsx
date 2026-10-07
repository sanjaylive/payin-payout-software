'use client';

import { PageHeader } from '@/components/common/page-header';
import { RiskEventsTable } from '@/features/risk/risk-events';

export default function RiskReviewsPage() {
  return (
    <>
      <PageHeader title="Manual reviews" description="Held payouts and enforced controls waiting for a decision. Clear a false positive to lift its controls, or confirm to keep them and reject a held payout." />
      <RiskEventsTable reviewQueue />
    </>
  );
}
