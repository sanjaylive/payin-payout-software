'use client';

import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { cn } from '@pay2all/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, Loader2, Pencil, Send, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { ME_QUERY_KEY } from '@/lib/auth/use-me';
import { DocumentsSection } from '../merchants/documents-section';
import { ENTITY_LABELS } from '../merchants/labels';
import { useInvalidateMerchant } from '../merchants/use-merchant';
import type { StepKey, StepProgress } from './steps';

const rupees = (v: string | null) => (v ? `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : null);

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words', !value && 'text-muted-foreground italic')}>{value || 'Not provided'}</dd>
    </div>
  );
}

function Block({ progress, onEdit, children }: { progress: StepProgress; onEdit: (k: StepKey) => void; children: ReactNode }) {
  const { step, complete, done, total } = progress;
  return (
    <section className="rounded-xl border p-4">
      <header className="mb-2 flex items-center gap-2">
        {complete ? <CircleCheck className="text-success size-4" /> : <CircleDashed className="text-warning size-4" />}
        <h3 className="flex-1 text-sm font-semibold">{step.title}</h3>
        <span className="text-muted-foreground text-xs tabular-nums">{done}/{total}</span>
        <Button variant="ghost" size="sm" onClick={() => onEdit(step.key)}><Pencil /> Edit</Button>
      </header>
      <dl>{children}</dl>
    </section>
  );
}

/** Everything on one page, what's still missing, the declaration and the submit button. */
export function ReviewStep({ app, progress, canEdit, canUpload, onEdit }: { app: MerchantApplication; progress: StepProgress[]; canEdit: boolean; canUpload: boolean; onEdit: (k: StepKey) => void }) {
  const invalidate = useInvalidateMerchant(app.id);
  const qc = useQueryClient();
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = app.profile;
  const by = Object.fromEntries(progress.map((x) => [x.step.key, x])) as Record<StepKey, StepProgress>;
  const missing = progress.flatMap((x) => x.items.filter((i) => !i.satisfied).map((i) => ({ ...i, step: x.step })));
  const primary = app.bank_accounts.find((b) => b.is_primary);
  const resubmit = app.status === 'MORE_INFORMATION_REQUIRED';

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/v1/merchants/${app.id}/submit`);
      toast.success(resubmit ? 'Application resubmitted' : 'Application submitted for review');
      await Promise.all([invalidate(), qc.invalidateQueries({ queryKey: ME_QUERY_KEY })]);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {missing.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>{missing.length} item{missing.length === 1 ? '' : 's'} left before you can submit</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-1">
              {missing.map((m) => (
                <li key={m.key}>
                  <button type="button" className="hover:text-foreground text-left underline-offset-2 hover:underline" onClick={() => onEdit(m.step.key)}>
                    {m.label} <span className="text-muted-foreground">· {m.step.short}</span>
                  </button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Block progress={by.business} onEdit={onEdit}>
          <Row label="Legal name" value={p.legal_name} />
          <Row label="Entity type" value={p.entity_type ? ENTITY_LABELS[p.entity_type] : null} />
          <Row label="PAN" value={p.pan && <span className="font-mono">{p.pan}</span>} />
          {p.gstin && <Row label="GSTIN" value={<span className="font-mono">{p.gstin}</span>} />}
          {(p.cin || p.llpin) && <Row label={p.cin ? 'CIN' : 'LLPIN'} value={<span className="font-mono">{p.cin ?? p.llpin}</span>} />}
          <Row label="Address" value={p.registered_address && [p.registered_address.line1, p.registered_address.line2, p.registered_address.city, p.registered_address.state, p.registered_address.pincode].filter(Boolean).join(', ')} />
        </Block>
        <Block progress={by.activity} onEdit={onEdit}>
          <Row label="Display name" value={p.display_name} />
          <Row label="Website / app" value={p.website ?? p.app_url} />
          <Row label="Category" value={p.business_category && `${p.business_category}${p.mcc ? ` · MCC ${p.mcc}` : ''}`} />
          <Row label="Monthly volume" value={rupees(p.expected_monthly_volume)} />
          <Row label="Services" value={[p.payin_required && 'Payin', p.payout_required && 'Payout'].filter(Boolean).join(' + ')} />
          <Row label="Contact" value={p.contact_name && `${p.contact_name}${p.contact_email ? ` · ${p.contact_email}` : ''}`} />
        </Block>
        <Block progress={by.people} onEdit={onEdit}>
          {app.persons.length ? (
            app.persons.map((x) => (
              <Row
                key={x.id}
                label={x.full_name}
                value={[x.is_director && 'Director', x.is_ubo && `Owner${x.ownership_percent ? ` ${x.ownership_percent}%` : ''}`, x.is_authorized_signatory && 'Signatory'].filter(Boolean).join(' · ')}
              />
            ))
          ) : (
            <Row label="People" value={null} />
          )}
        </Block>
        <Block progress={by.bank} onEdit={onEdit}>
          <Row label="Account" value={primary && <span className="font-mono">{primary.account_number_masked}</span>} />
          <Row label="Holder" value={primary?.account_holder_name} />
          <Row label="IFSC" value={primary && <span className="font-mono">{primary.ifsc}</span>} />
        </Block>
        <div className="lg:col-span-2">
          <Block progress={by.documents} onEdit={onEdit}>
            <Row label="Uploaded" value={`${app.documents.filter((d) => d.status !== 'REJECTED' && d.type !== 'AGREEMENT').length} document(s)`} />
          </Block>
        </div>
      </div>

      <DocumentsSection
        app={app}
        canUpload={canUpload}
        onlyType="AGREEMENT"
        title="Signed merchant agreement (optional now)"
        description="If you already have the agreement from your account manager, upload the signed copy. Otherwise we'll share it during review; it's needed before approval, not to submit."
      />

      {canEdit && (
        <div className="bg-muted/30 space-y-4 rounded-xl border p-5">
          <label className="flex items-start gap-3 text-sm leading-5">
            <Checkbox checked={declared} onCheckedChange={(v) => setDeclared(v === true)} className="mt-0.5" />
            <span>
              I confirm that the information and documents provided are true and complete, that I am authorised to submit them on behalf of the business, and that the
              business will notify us of any material change.
            </span>
          </label>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-xs">Details are locked while our compliance team reviews them. Reviews usually take 1–2 working days.</p>
            <Button size="lg" onClick={() => void submit()} disabled={!app.can_submit || !declared || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />} {resubmit ? 'Resubmit application' : 'Submit for review'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
