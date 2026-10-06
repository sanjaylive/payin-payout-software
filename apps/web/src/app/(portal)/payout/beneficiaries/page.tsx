'use client';

import { PageHeader } from '@/components/common/page-header';
import { BeneficiariesTable } from '@/features/payout/beneficiaries';

export default function BeneficiariesPage() {
  return (
    <>
      <PageHeader title="Beneficiaries" description="Saved payout destinations. Verify a beneficiary to pay more than ₹25,000; the bank-registered name is checked against yours." />
      <BeneficiariesTable />
    </>
  );
}
