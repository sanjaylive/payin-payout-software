'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { OrganizationsTable } from '@/features/organizations-table';
import { AdminCommissions } from '@/features/resellers/admin-commissions';

export default function AdminResellersPage() {
  return (
    <>
      <PageHeader title="Resellers" description="Partners who onboard and manage their own merchants, earning the margin over their wholesale price." />
      <Tabs defaultValue="resellers">
        <TabsList><TabsTrigger value="resellers">Resellers</TabsTrigger><TabsTrigger value="commissions">Commissions</TabsTrigger></TabsList>
        <TabsContent value="resellers" className="mt-4"><Suspense><OrganizationsTable type="RESELLER" /></Suspense></TabsContent>
        <TabsContent value="commissions" className="mt-4"><AdminCommissions /></TabsContent>
      </Tabs>
    </>
  );
}
