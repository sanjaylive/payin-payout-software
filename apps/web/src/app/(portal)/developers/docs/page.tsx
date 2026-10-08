'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { ApiReference } from '@/features/docs/api-reference';

export default function ApiDocsPage() {
  return (
    <>
      <PageHeader
        title="API documentation"
        description="Accept payments with hosted checkout or the Payments API, send payouts, and receive signed webhooks."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href="/docs" target="_blank" rel="noopener noreferrer">
              Open public docs <ExternalLink className="size-3.5" />
            </a>
          </Button>
        }
      />
      <ApiReference />
    </>
  );
}
