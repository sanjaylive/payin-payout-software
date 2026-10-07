'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { ActiveRiskControls, RiskEventsTable } from '@/features/risk/risk-events';

export default function RiskEventsPage() {
  return (
    <>
      <PageHeader title="Risk events" description="Every rule hit with exactly what was observed, and the merchant controls currently in force." />
      <Tabs defaultValue="events">
        <TabsList><TabsTrigger value="events">Events</TabsTrigger><TabsTrigger value="controls">Active controls</TabsTrigger></TabsList>
        <TabsContent value="events" className="mt-4"><RiskEventsTable /></TabsContent>
        <TabsContent value="controls" className="mt-4"><ActiveRiskControls /></TabsContent>
      </Tabs>
    </>
  );
}
