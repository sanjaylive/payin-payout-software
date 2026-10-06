'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { DeliveryLog } from '@/features/webhooks/delivery-log';
import { DeadLetters, PipelineOverview } from '@/features/webhooks/pipeline';

export default function AdminWebhooksPage() {
  return (
    <>
      <PageHeader title="Events & webhooks" description="Outbox → Kafka pipeline health, dead letters, and merchant webhook deliveries across all merchants." />
      <PipelineOverview />
      <Tabs defaultValue="deliveries" className="mt-6">
        <TabsList>
          <TabsTrigger value="deliveries">Webhook deliveries</TabsTrigger>
          <TabsTrigger value="dlq">Dead letters</TabsTrigger>
        </TabsList>
        <TabsContent value="deliveries" className="mt-4"><DeliveryLog internal /></TabsContent>
        <TabsContent value="dlq" className="mt-4"><DeadLetters /></TabsContent>
      </Tabs>
    </>
  );
}
