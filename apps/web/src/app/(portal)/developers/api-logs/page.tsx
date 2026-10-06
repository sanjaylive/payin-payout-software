'use client';

import { PageHeader } from '@/components/common/page-header';
import { ApiLogsTable, ApiUsageOverview } from '@/features/developers/api-logs';

export default function ApiLogsPage() {
  return (
    <>
      <PageHeader title="API usage & logs" description="Every signed request with its result (no request bodies are stored). Kept for 90 days." />
      <ApiUsageOverview />
      <div className="mt-6"><ApiLogsTable /></div>
    </>
  );
}
