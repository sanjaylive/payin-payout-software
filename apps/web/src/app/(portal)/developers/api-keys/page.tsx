'use client';

import { PageHeader } from '@/components/common/page-header';
import { ApiKeys } from '@/features/developers/api-keys';

export default function ApiKeysPage() {
  return (
    <>
      <PageHeader title="API keys" description="Server-to-server credentials. Each request is signed with the key's secret; secrets are shown once." />
      <ApiKeys />
    </>
  );
}
