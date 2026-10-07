'use client';

import { PageHeader } from '@/components/common/page-header';
import { RiskRules } from '@/features/risk/risk-rules';

export default function RiskRulesPage() {
  return (
    <>
      <PageHeader title="Risk rules" description="Configurable checks on payins and payouts. Monitor mode records what a rule would do without acting; every change is versioned and audited." />
      <RiskRules />
    </>
  );
}
