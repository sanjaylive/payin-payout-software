'use client';

import { ActivityTimeline } from '@pay2all/ui/components/timeline';
import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { errorMessage } from '@/lib/api/errors';
import { useCan, useMe } from '@/lib/auth/use-me';
import { IpAllowlist } from '../developers/ip-allowlist';
import { LoginActivity } from '../security/login-activity';
import { WebhookEndpoints } from '../webhooks/endpoints';
import { JournalsTable } from '../ledger/admin-ledger';
import { BalanceCards } from '../ledger/balance-cards';
import { BankAccountsSection } from './bank-accounts-section';
import { DocumentsSection } from './documents-section';
import { isEditableStatus, REVIEW_ACTION_LABELS } from './labels';
import { MerchantSchemePanel } from '@/features/schemes/merchant-scheme-panel';
import { MerchantLimitsPanel } from './limits-panel';
import { PeopleSection } from './people-section';
import { ProfileForm } from './profile-form';
import { RequirementList, RequirementsPanel } from './requirements-panel';
import { ReviewActions } from './review-actions';
import { ScreeningPanel } from './screening-panel';
import { useMerchant } from './use-merchant';

/** Merchant 360 for platform staff and resellers: application, review actions, screening, limits, history. */
export function MerchantDetail({ merchantId, backHref }: { merchantId: string; backHref: string }) {
  const can = useCan();
  const { data: me } = useMe();
  const platform = me?.organization.type === 'PLATFORM';
  const { data: app, isPending, isError, error, refetch } = useMerchant(merchantId);
  if (isPending) return <LoadingSkeleton rows={8} />;
  if (isError || !app) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  const editable = can('merchant.update') && isEditableStatus(app.status);
  const approval = app.requirements.filter((r) => r.stage === 'APPROVAL');

  return (
    <div className="space-y-6">
      <Link href={backHref} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" /> Merchants</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">{app.name} <StatusBadge status={app.status} /></h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {app.legal_name ?? 'Legal name pending'} · <span className="font-mono">{app.id}</span> · {app.reseller ? `via ${app.reseller.name}` : 'Direct'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={app.payin_enabled ? 'default' : 'outline'}>Payin {app.payin_enabled ? 'on' : 'off'}</Badge>
            <Badge variant={app.payout_enabled ? 'default' : 'outline'}>Payout {app.payout_enabled ? 'on' : 'off'}</Badge>
            {app.risk_category && <StatusBadge status={`${app.risk_category} RISK`} tone={app.risk_category === 'HIGH' ? 'danger' : app.risk_category === 'MEDIUM' ? 'warning' : 'success'} />}
          </div>
        </div>
        <ReviewActions app={app} />
      </div>

      <Tabs defaultValue="application">
        <TabsList className="flex-wrap">
          <TabsTrigger value="application">Application</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="documents">Documents ({app.documents.length})</TabsTrigger>
          <TabsTrigger value="bank">Bank</TabsTrigger>
          {app.screening?.risk_notes !== undefined && <TabsTrigger value="screening">Screening</TabsTrigger>}
          {can('ledger.read') && (app.status === 'APPROVED' || app.status === 'SUSPENDED') && <TabsTrigger value="ledger">Balances</TabsTrigger>}
          {can('limit.read') && <TabsTrigger value="limits">Limits</TabsTrigger>}
          {platform && can('pricing.read') && <TabsTrigger value="pricing">Pricing</TabsTrigger>}
          {platform && can('webhook.read') && <TabsTrigger value="webhooks">Webhooks</TabsTrigger>}
          {platform && can('merchant.read') && <TabsTrigger value="ip">IP allowlist</TabsTrigger>}
          {can('user.read') && <TabsTrigger value="logins">Login activity</TabsTrigger>}
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="application" className="mt-4 space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <RequirementsPanel app={app} canEdit={editable} />
            <Card className="shadow-none">
              <CardHeader><CardTitle className="text-base">Approval prerequisites</CardTitle></CardHeader>
              <CardContent><RequirementList items={approval} /></CardContent>
            </Card>
          </div>
          <ProfileForm key={app.version} app={app} readOnly={!editable} />
        </TabsContent>
        <TabsContent value="people" className="mt-4"><PeopleSection app={app} canEdit={editable} /></TabsContent>
        <TabsContent value="documents" className="mt-4"><DocumentsSection app={app} canUpload={can('merchant.update') || can('compliance.approve')} /></TabsContent>
        <TabsContent value="bank" className="mt-4"><BankAccountsSection app={app} canEdit={editable} /></TabsContent>
        <TabsContent value="screening" className="mt-4"><ScreeningPanel key={app.version} app={app} /></TabsContent>
        <TabsContent value="ledger" className="mt-4 space-y-6">
          <BalanceCards merchantId={app.id} />
          {can('ledger.platform.read') && <JournalsTable merchantId={app.id} />}
        </TabsContent>
        <TabsContent value="limits" className="mt-4"><MerchantLimitsPanel merchantId={app.id} /></TabsContent>
        <TabsContent value="pricing" className="mt-4"><MerchantSchemePanel merchantId={app.id} /></TabsContent>
        <TabsContent value="webhooks" className="mt-4 space-y-3">
          <p className="text-muted-foreground text-sm">Endpoints you add here belong to {app.name}: they see and manage them in their own dashboard. Every change is recorded in the audit log as made by Pay2All on their behalf.</p>
          <WebhookEndpoints merchantId={app.id} />
        </TabsContent>
        <TabsContent value="ip" className="mt-4 space-y-3">
          <p className="text-muted-foreground text-sm">Server addresses allowed to call the Pay2All API with {app.name}’s keys. Changes are audited as made on their behalf.</p>
          <IpAllowlist merchantId={app.id} />
        </TabsContent>
        <TabsContent value="logins" className="mt-4"><LoginActivity organizationId={app.id} /></TabsContent>
        <TabsContent value="history" className="mt-4">
          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-base">Compliance history</CardTitle></CardHeader>
            <CardContent>
              <ActivityTimeline
                items={app.reviews.map((r) => ({
                  id: r.id,
                  title: REVIEW_ACTION_LABELS[r.action] ?? r.action,
                  timestamp: r.reviewed_at,
                  tone: r.action === 'APPROVED' || r.action === 'REACTIVATED' ? 'success' : r.action === 'REJECTED' || r.action === 'SUSPENDED' ? 'danger' : r.action === 'INFORMATION_REQUESTED' ? 'warning' : 'default',
                  description: (
                    <div className="space-y-0.5">
                      {r.reason && <p>{r.reason}</p>}
                      {r.notes && <p className="italic">{r.notes}</p>}
                      <p className="font-mono text-xs">by {r.reviewed_by_id ?? 'system'} · {formatDateTime(r.reviewed_at)}</p>
                    </div>
                  ),
                }))}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
