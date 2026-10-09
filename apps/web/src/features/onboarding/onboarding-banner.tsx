'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { ArrowRight, Rocket } from 'lucide-react';
import Link from 'next/link';
import { isEditableStatus } from '../merchants/labels';
import { useMerchant } from '../merchants/use-merchant';
import { overall } from './steps';

/** Dashboard call to action until the merchant is approved: progress and a link back into the wizard. */
export function OnboardingBanner({ merchantId }: { merchantId: string }) {
  const { data: app } = useMerchant(merchantId);
  if (!app || app.status === 'APPROVED') return null;
  const editable = isEditableStatus(app.status);
  const { done, total, percent } = overall(app);
  return (
    <div className="from-primary/10 border-primary/20 mb-6 flex flex-col gap-4 rounded-xl border bg-gradient-to-r to-transparent p-5 sm:flex-row sm:items-center">
      <span className="bg-primary text-primary-foreground flex size-11 shrink-0 items-center justify-center rounded-xl"><Rocket className="size-5" /></span>
      <div className="flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{editable ? 'Finish onboarding to go live' : 'Your application is with our compliance team'}</p>
          <StatusBadge status={app.status} />
        </div>
        {editable ? (
          <div className="flex items-center gap-3">
            <div className="bg-muted h-1.5 max-w-xs flex-1 overflow-hidden rounded-full">
              <div className="bg-primary h-full rounded-full transition-all" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">{done}/{total} done</span>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">You can explore the dashboard in test mode meanwhile.</p>
        )}
      </div>
      <Button asChild>
        <Link href="/onboarding">{editable ? 'Continue onboarding' : 'View status'} <ArrowRight /></Link>
      </Button>
    </div>
  );
}
