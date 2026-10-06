'use client';

import { PageHeader } from '@/components/common/page-header';
import { DeliveryLog } from '@/features/webhooks/delivery-log';

export default function WebhookLogsPage() {
  return (
    <>
      <PageHeader title="Webhook log" description="Every delivery attempt with the response we received. Failed deliveries retry automatically for 2 days; you can replay any delivery." />
      <DeliveryLog />
    </>
  );
}
