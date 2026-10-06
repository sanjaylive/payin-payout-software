'use client';

import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PayoutsTable } from '@/features/payout/payouts-table';

export default function ApprovalsPage() {
  return (
    <>
      <PageHeader title="Approvals" description="Payouts created by your team that need your approval. You can’t approve payouts you created." />
      <Alert className="mb-4">
        <ShieldCheck />
        <AlertDescription>
          Approving needs two-factor authentication on your session. If approvals fail, set it up in <Link href="/settings/security" className="text-primary font-medium hover:underline">Settings → Security</Link> and sign in again.
        </AlertDescription>
      </Alert>
      <PayoutsTable awaitingMyApproval />
    </>
  );
}
