'use client';

import { BankAccountsSection } from '@/features/merchants/bank-accounts-section';
import { OwnApplication } from '@/features/merchants/own-application';

export default function BankAccountPage() {
  return (
    <OwnApplication title="Bank account" description="Where your settlements are paid.">
      {(app, { canEdit }) => <BankAccountsSection app={app} canEdit={canEdit} />}
    </OwnApplication>
  );
}
