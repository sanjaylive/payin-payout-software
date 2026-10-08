'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { FundRequestsAdmin } from '@/features/funds/fund-requests-admin';
import { FundStatements } from '@/features/funds/statements';
import { useCan } from '@/lib/auth/use-me';

export default function FundRequestsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader title="Fund requests" description="Merchants pay into a fund account and submit the UTR. Import the bank statement to credit exact matches automatically, or verify and approve by hand." />
      <Tabs defaultValue="requests">
        <TabsList className="mb-4">
          <TabsTrigger value="requests">Requests</TabsTrigger>
          {can('fund.approve') && <TabsTrigger value="statements">Bank statements</TabsTrigger>}
        </TabsList>
        <TabsContent value="requests">
          <Suspense>
            <FundRequestsAdmin />
          </Suspense>
        </TabsContent>
        {can('fund.approve') && (
          <TabsContent value="statements">
            <FundStatements />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
