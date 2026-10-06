'use client';

import { PageHeader } from '@/components/common/page-header';
import { HealthBoard } from '@/features/providers/health-board';

export default function HealthPage() {
  return (
    <>
      <PageHeader title="Provider health" description="Live 15-minute success rates and latency. Refreshes every 10 seconds." />
      <HealthBoard />
    </>
  );
}
