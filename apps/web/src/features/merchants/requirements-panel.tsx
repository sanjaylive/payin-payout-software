'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { cn } from '@pay2all/ui/lib/utils';
import { CircleCheck, CircleDashed, Info, Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication, Requirement } from '@/lib/api/types';
import { useInvalidateMerchant } from './use-merchant';

const STATUS_COPY: Record<string, string> = {
  DRAFT: 'Complete the checklist below, then submit your application for compliance review.',
  SUBMITTED: 'Your application is in the compliance queue. Details are locked while it is reviewed.',
  UNDER_REVIEW: 'Our compliance team is reviewing your application.',
  MORE_INFORMATION_REQUIRED: 'Compliance needs more information. Update your application and resubmit.',
  APPROVED: 'Your business is approved.',
  REJECTED: 'Your application was not approved. Contact your account manager for details.',
  SUSPENDED: 'Your account is suspended. Contact support.',
};

export function RequirementList({ items, stage }: { items: Requirement[]; stage?: Requirement['stage'] }) {
  return (
    <ul className="space-y-2">
      {items
        .filter((r) => !stage || r.stage === stage)
        .map((r) => (
          <li key={r.key} className="flex items-start gap-2 text-sm">
            {r.satisfied ? <CircleCheck className="text-success mt-0.5 size-4 shrink-0" /> : <CircleDashed className="text-muted-foreground mt-0.5 size-4 shrink-0" />}
            <span className={cn(r.satisfied && 'text-muted-foreground')}>{r.label}</span>
          </li>
        ))}
    </ul>
  );
}

/** Application status, the submission checklist, the latest reviewer request and the submit action. */
export function RequirementsPanel({ app, canEdit }: { app: MerchantApplication; canEdit: boolean }) {
  const invalidate = useInvalidateMerchant(app.id);
  const [submitting, setSubmitting] = useState(false);
  const submission = app.requirements.filter((r) => r.stage === 'SUBMISSION');
  const done = submission.filter((r) => r.satisfied).length;
  const lastRequest = app.status === 'MORE_INFORMATION_REQUIRED' ? app.reviews.find((r) => r.action === 'INFORMATION_REQUESTED') : undefined;

  async function submit() {
    setSubmitting(true);
    try {
      await api.post(`/v1/merchants/${app.id}/submit`);
      toast.success('Application submitted for review');
      await invalidate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            Application status <StatusBadge status={app.status} />
          </CardTitle>
          <p className="text-muted-foreground text-sm">{STATUS_COPY[app.status]}</p>
        </div>
        {canEdit && (app.status === 'DRAFT' || app.status === 'MORE_INFORMATION_REQUIRED') && (
          <Button onClick={() => void submit()} disabled={!app.can_submit || submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Send />} {app.status === 'DRAFT' ? 'Submit for review' : 'Resubmit'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {lastRequest && (
          <Alert>
            <Info />
            <AlertTitle>Requested by compliance</AlertTitle>
            <AlertDescription>
              <p>{lastRequest.reason}</p>
              {lastRequest.notes && <p className="mt-1">{lastRequest.notes}</p>}
            </AlertDescription>
          </Alert>
        )}
        {app.status !== 'APPROVED' && (
          <>
            <div className="flex items-center gap-3">
              <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                <div className="bg-primary h-full rounded-full transition-all" style={{ width: `${(done / Math.max(submission.length, 1)) * 100}%` }} />
              </div>
              <span className="text-muted-foreground text-xs tabular-nums">
                {done}/{submission.length} complete
              </span>
            </div>
            <RequirementList items={app.requirements} stage="SUBMISSION" />
          </>
        )}
      </CardContent>
    </Card>
  );
}
