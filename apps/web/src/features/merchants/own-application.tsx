'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { isEditableStatus } from './labels';
import { RequirementsPanel } from './requirements-panel';
import { useMerchant } from './use-merchant';

/** Loads the signed-in merchant's own application (merchant id == organization id). */
export function OwnApplication({
  title,
  description,
  children,
  showRequirements = false,
}: {
  title: string;
  description?: string;
  showRequirements?: boolean;
  children: (app: MerchantApplication, perms: { canEdit: boolean; canUpload: boolean }) => ReactNode;
}) {
  const { data: me } = useMe();
  const can = useCan();
  const isMerchant = me?.organization.type === 'MERCHANT';
  const merchant = useMerchant(isMerchant ? me.organization.id : undefined);

  if (me && !isMerchant) {
    return <ErrorState title="Not available" message="Compliance onboarding applies to merchant accounts." />;
  }
  if (merchant.isPending) return <LoadingSkeleton rows={6} />;
  if (merchant.isError) return <ErrorState message={errorMessage(merchant.error)} onRetry={() => void merchant.refetch()} />;

  const app = merchant.data;
  const canEdit = can('merchant.update') && isEditableStatus(app.status);
  const canUpload = can('merchant.update') && !['SUBMITTED', 'UNDER_REVIEW', 'REJECTED'].includes(app.status);
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="space-y-6">
        {showRequirements && <RequirementsPanel app={app} canEdit={canEdit} />}
        {children(app, { canEdit, canUpload })}
      </div>
    </>
  );
}
