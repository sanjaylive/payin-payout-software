'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { PricingAssignments } from '@/features/pricing/pricing-assignments';
import { MerchantSchemes } from '@/features/schemes/merchant-schemes';

export default function MerchantPricingPage() {
  return (
    <>
      <PageHeader title="Merchant schemes" description="Put merchants on a pricing scheme — one by one, in bulk, or all at once — and choose the scheme new merchants join." />
      <Tabs defaultValue="schemes">
        <TabsList>
          <TabsTrigger value="schemes">Schemes</TabsTrigger>
          <TabsTrigger value="rate-cards">Rate cards</TabsTrigger>
        </TabsList>
        <TabsContent value="schemes" className="mt-4">
          <MerchantSchemes />
        </TabsContent>
        <TabsContent value="rate-cards" className="mt-4">
          <PricingAssignments />
        </TabsContent>
      </Tabs>
    </>
  );
}
