'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { WebhookEndpoints } from '@/features/webhooks/endpoints';

export default function WebhooksPage() {
  return (
    <>
      <PageHeader
        title="Webhooks"
        description={<>Receive payment, refund and payout events as signed HTTPS requests. Delivery history is in the <Link href="/developers/webhook-logs" className="text-primary font-medium hover:underline">webhook log</Link>.</>}
      />
      <WebhookEndpoints />
    </>
  );
}
