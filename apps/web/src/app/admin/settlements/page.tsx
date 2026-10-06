'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { HoldsPanel, RemittancesPanel, SchedulesPanel, SettlementActions } from '@/features/settlements/admin-panels';
import { SettlementsTable } from '@/features/settlements/settlements';

export default function AdminSettlementsPage() {
  return (
    <>
      <PageHeader title="Settlements" description="Merchant settlements, schedules, holds and provider remittances." actions={<SettlementActions />} />
      <Tabs defaultValue="transit">
        <TabsList className="flex-wrap">
          <TabsTrigger value="transit">In transit</TabsTrigger>
          <TabsTrigger value="all">All settlements</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="holds">Holds</TabsTrigger>
          <TabsTrigger value="remittances">Provider remittances</TabsTrigger>
        </TabsList>
        <TabsContent value="transit" className="mt-4"><SettlementsTable internal status="PROCESSING" /></TabsContent>
        <TabsContent value="all" className="mt-4"><SettlementsTable internal /></TabsContent>
        <TabsContent value="schedules" className="mt-4"><SchedulesPanel /></TabsContent>
        <TabsContent value="holds" className="mt-4"><HoldsPanel /></TabsContent>
        <TabsContent value="remittances" className="mt-4"><RemittancesPanel /></TabsContent>
      </Tabs>
    </>
  );
}
