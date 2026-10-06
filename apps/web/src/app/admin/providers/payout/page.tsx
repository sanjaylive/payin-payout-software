'use client';

import { PageHeader } from '@/components/common/page-header';
import { ProvidersList } from '@/features/providers/providers-list';

export default function PayoutProvidersPage() {
  return (
    <>
      <PageHeader title="Payout providers" description="Disbursement partners. Status is managed automatically by health checks unless set manually." />
      <ProvidersList kind="PAYOUT" />
    </>
  );
}
