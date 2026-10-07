'use client';

import { PageHeader } from '@/components/common/page-header';
import { HealthBoard } from '@/features/providers/health-board';

export default function VendorHealthPage() {
  return (
    <>
      <PageHeader level={2} title="Vendor health" description="Live success rate and latency of each payment service, from real traffic and probes." />
      <HealthBoard />
    </>
  );
}
