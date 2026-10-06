'use client';

import { PageHeader } from '@/components/common/page-header';
import { ApiDocs } from '@/features/developers/api-docs';

export default function ApiDocsPage() {
  return (
    <>
      <PageHeader title="API documentation" description="Authenticate, sign requests and call the Pay2All API from your server." />
      <ApiDocs />
    </>
  );
}
