'use client';

import { PageHeader } from '@/components/common/page-header';
import { ProvidersList } from '@/features/providers/providers-list';

export default function PayinProvidersPage() {
  return (
    <>
      <PageHeader title="Payin providers" description="Collection partners. Status is managed automatically by health checks unless set manually." />
      <ProvidersList kind="PAYIN" />
    </>
  );
}
