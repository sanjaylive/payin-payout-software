'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { CircleCheck, Loader2, MessageSquareWarning, Play, ShieldBan, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { RequirementList } from './requirements-panel';
import { useInvalidateMerchant } from './use-merchant';

type Decision = 'request-information' | 'reject' | 'suspend' | 'reactivate';

const DECISIONS: Record<Decision, { title: string; label: string; path: string; destructive: boolean; description: string }> = {
  'request-information': { title: 'Request more information', label: 'Send request', path: 'review/request-information', destructive: false, description: 'The merchant is emailed your reason and can edit and resubmit.' },
  reject: { title: 'Reject application', label: 'Reject', path: 'review/reject', destructive: true, description: 'Rejection is final for this application.' },
  suspend: { title: 'Suspend merchant', label: 'Suspend', path: 'suspend', destructive: true, description: 'All payins and payouts are blocked until reactivated.' },
  reactivate: { title: 'Reactivate merchant', label: 'Reactivate', path: 'reactivate', destructive: false, description: 'Services resume with the previous settings.' },
};

function ApproveDialog({ app, open, onOpenChange }: { app: MerchantApplication; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateMerchant(app.id);
  const [risk, setRisk] = useState(app.risk_category ?? 'LOW');
  const [payin, setPayin] = useState(app.profile.payin_required);
  const [payout, setPayout] = useState(app.profile.payout_required);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const approvalGaps = app.requirements.filter((r) => !r.satisfied);

  async function approve() {
    setBusy(true);
    try {
      await api.post(`/v1/merchants/${app.id}/review/approve`, { reason, notes: notes || undefined, risk_category: risk, payin_enabled: payin, payout_enabled: payout });
      toast.success('Merchant approved');
      onOpenChange(false);
      await invalidate();
    } catch (e) {
      toast.error(e instanceof ApiError && e.details?.length ? `${e.message}: ${e.details.map((d) => d.message).join('; ')}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve {app.name}</DialogTitle>
          <DialogDescription>Your decision, reason and notes are recorded permanently in the compliance history.</DialogDescription>
        </DialogHeader>
        {approvalGaps.length > 0 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">These prerequisites must be met first:</p>
            <RequirementList items={approvalGaps} />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="risk">Risk category</Label>
              <Select value={risk} onValueChange={(v) => setRisk(v as typeof risk)}>
                <SelectTrigger id="risk" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="LOW">Low</SelectItem><SelectItem value="MEDIUM">Medium</SelectItem><SelectItem value="HIGH">High</SelectItem></SelectContent>
              </Select>
            </div>
            <label className="flex items-center justify-between rounded-lg border p-3 text-sm">Enable Payin <Switch checked={payin} onCheckedChange={setPayin} /></label>
            <label className="flex items-center justify-between rounded-lg border p-3 text-sm">Enable Payout <Switch checked={payout} onCheckedChange={setPayout} /></label>
            <div className="space-y-1.5">
              <Label htmlFor="approve-reason">Reason</Label>
              <Textarea id="approve-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="approve-notes">Internal notes (optional)</Label>
              <Textarea id="approve-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || approvalGaps.length > 0 || reason.trim().length < 5} onClick={() => void approve()}>
            {busy ? <Loader2 className="animate-spin" /> : <CircleCheck />} Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Status-aware compliance actions; each button only appears when the transition and permission allow it. */
export function ReviewActions({ app }: { app: MerchantApplication }) {
  const can = useCan();
  const invalidate = useInvalidateMerchant(app.id);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [approving, setApproving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      setDecision(null);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const s = app.status;
  return (
    <div className="flex flex-wrap gap-2">
      {s === 'SUBMITTED' && can('compliance.approve') && (
        <Button disabled={busy} onClick={() => void run(() => api.post(`/v1/merchants/${app.id}/review/start`), 'Review started')}><Play /> Start review</Button>
      )}
      {s === 'UNDER_REVIEW' && can('compliance.approve') && (
        <Button variant="outline" onClick={() => setDecision('request-information')}><MessageSquareWarning /> Request info</Button>
      )}
      {s === 'UNDER_REVIEW' && can('merchant.approve') && (
        <>
          <Button variant="outline" onClick={() => setDecision('reject')}><XCircle /> Reject</Button>
          <Button onClick={() => setApproving(true)}><ShieldCheck /> Approve</Button>
        </>
      )}
      {s === 'APPROVED' && can('merchant.suspend') && <Button variant="outline" onClick={() => setDecision('suspend')}><ShieldBan /> Suspend</Button>}
      {s === 'SUSPENDED' && can('merchant.suspend') && <Button onClick={() => setDecision('reactivate')}>Reactivate</Button>}

      {decision && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDecision(null)}
          title={DECISIONS[decision].title}
          description={DECISIONS[decision].description}
          confirmLabel={DECISIONS[decision].label}
          destructive={DECISIONS[decision].destructive}
          requireReason
          pending={busy}
          onConfirm={(reason) => void run(() => api.post(`/v1/merchants/${app.id}/${DECISIONS[decision].path}`, { reason }), 'Saved')}
        />
      )}
      <ApproveDialog key={String(approving)} app={app} open={approving} onOpenChange={setApproving} />
    </div>
  );
}
