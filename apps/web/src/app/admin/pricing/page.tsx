'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PricingPlans } from '@/features/pricing/pricing-plans';
import { SchemesList } from '@/features/schemes/schemes-list';
import { useCan } from '@/lib/auth/use-me';

export default function PricingPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Pricing"
        description="Schemes set a charge or commission per provider and amount slab. Every transaction records the exact pricing it was charged."
        actions={
          can('pricing.manage') && (
            <Button asChild>
              <Link href="/admin/pricing/schemes/new">
                <Plus className="size-4" /> New scheme
              </Link>
            </Button>
          )
        }
      />
      <Tabs defaultValue="schemes">
        <TabsList>
          <TabsTrigger value="schemes">Schemes</TabsTrigger>
          <TabsTrigger value="rate-cards">Rate cards</TabsTrigger>
        </TabsList>
        <TabsContent value="schemes" className="mt-4">
          <SchemesList />
        </TabsContent>
        <TabsContent value="rate-cards" className="mt-4 space-y-3">
          <p className="text-muted-foreground text-sm">Advanced: provider costs, reseller wholesale, and merchant rate cards for merchants not on a scheme.</p>
          <PricingPlans />
        </TabsContent>
      </Tabs>
    </>
  );
}
