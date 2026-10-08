'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { QrCode } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PaymentsTable } from '@/features/payin/payments-table';
import { StaticQrCodes } from '@/features/payin/static-qr';
import { useCan } from '@/lib/auth/use-me';

export default function QrCodesPage() {
  const can = useCan();
  return (
    <>
      <PageHeader title="QR codes" description="Static QR codes for your counter, and one-time QR codes for a specific amount." />
      <Tabs defaultValue="static">
        <TabsList className="mb-4">
          <TabsTrigger value="static">Static QR (any amount)</TabsTrigger>
          <TabsTrigger value="dynamic">One-time QR</TabsTrigger>
        </TabsList>
        <TabsContent value="static">
          <StaticQrCodes />
        </TabsContent>
        <TabsContent value="dynamic" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">Single-use, amount-specific UPI QR codes. Each one expires after its payment window.</p>
            {can('payin.create') && (
              <Button asChild>
                <Link href="/payin/create">
                  <QrCode /> New one-time QR
                </Link>
              </Button>
            )}
          </div>
          <PaymentsTable method="UPI_QR" />
        </TabsContent>
      </Tabs>
    </>
  );
}
