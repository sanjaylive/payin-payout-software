'use client';

import { Card, CardContent } from '@pay2all/ui/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { BalanceCards } from '@/features/ledger/balance-cards';
import { useMe } from '@/lib/auth/use-me';

export default function BalancePage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Balance" description="Every balance is computed from your double-entry ledger — it can't drift from your transactions." />
      <BalanceCards merchantId={me.organization.id} />
      <Card className="mt-6 shadow-none">
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p><span className="text-foreground font-medium">Unsettled</span> funds become <span className="text-foreground font-medium">Available</span> at your settlement cycle.</p>
          <p>Creating a payout moves the amount plus fees from Available to <span className="text-foreground font-medium">Reserved</span> until the bank confirms; failed payouts return to Available.</p>
        </CardContent>
      </Card>
    </>
  );
}
