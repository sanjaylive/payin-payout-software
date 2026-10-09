'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent } from '@pay2all/ui/components/ui/card';
import { cn } from '@pay2all/ui/lib/utils';
import { ArrowLeft, ArrowRight, Check, Clock, MessageSquareWarning } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { BankAccountsSection } from '../merchants/bank-accounts-section';
import { DocumentsSection } from '../merchants/documents-section';
import { isEditableStatus } from '../merchants/labels';
import { PeopleSection } from '../merchants/people-section';
import { ProfileForm } from '../merchants/profile-form';
import { useMerchant } from '../merchants/use-merchant';
import { RequiredDocuments } from './required-documents';
import { ReviewStep } from './review-step';
import { StatusView } from './status-view';
import { isStepKey, overall, STEPS, type StepKey, type StepProgress, stepProgress } from './steps';

function ProgressRing({ percent, size = 72 }: { percent: number; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={6} className="stroke-muted fill-none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          className={cn('fill-none transition-[stroke-dashoffset] duration-700', percent === 100 ? 'stroke-success' : 'stroke-primary')}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">{percent}%</span>
    </div>
  );
}

function StepIcon({ p, active }: { p: StepProgress; active: boolean }) {
  const Icon = p.step.icon;
  return (
    <span
      className={cn(
        'relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
        p.complete ? 'border-success bg-success text-success-foreground' : active ? 'border-primary bg-background text-primary' : 'border-border bg-background text-muted-foreground',
      )}
    >
      {p.complete ? <Check className="size-4" /> : <Icon className="size-4" />}
    </span>
  );
}

function Stepper({ progress, current, onSelect }: { progress: StepProgress[]; current: StepKey; onSelect: (k: StepKey) => void }) {
  return (
    <nav aria-label="Onboarding steps">
      <ol className="relative space-y-1">
        <span className="bg-border absolute top-5 bottom-5 left-[25px] w-0.5" aria-hidden />
        {progress.map((p) => {
          const active = p.step.key === current;
          return (
            <li key={p.step.key}>
              <button
                type="button"
                onClick={() => onSelect(p.step.key)}
                aria-current={active ? 'step' : undefined}
                className={cn('hover:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors', active && 'bg-primary/5 hover:bg-primary/10')}
              >
                <StepIcon p={p} active={active} />
                <span className="min-w-0">
                  <span className={cn('block text-sm', active ? 'font-semibold' : 'font-medium')}>{p.step.title}</span>
                  <span className="text-muted-foreground block text-xs">
                    {p.step.key === 'review' ? (p.complete ? 'Ready to submit' : 'Complete the steps above') : p.complete ? 'Done' : `${p.done} of ${p.total} done`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Compact stepper for small screens: a segmented bar and the step count. */
function MobileStepper({ progress, index, onSelect }: { progress: StepProgress[]; index: number; onSelect: (k: StepKey) => void }) {
  return (
    <div className="space-y-2 lg:hidden">
      <div className="flex gap-1">
        {progress.map((p, i) => (
          <button
            key={p.step.key}
            type="button"
            aria-label={p.step.title}
            onClick={() => onSelect(p.step.key)}
            className={cn('h-1.5 flex-1 rounded-full transition-colors', p.complete ? 'bg-success' : i === index ? 'bg-primary' : 'bg-muted')}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">Step {index + 1} of {progress.length}</p>
    </div>
  );
}

function Wizard({ app }: { app: MerchantApplication }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const can = useCan();
  const top = useRef<HTMLDivElement>(null);
  const canEdit = can('merchant.update') && isEditableStatus(app.status);
  const canUpload = canEdit;
  const progress = stepProgress(app);
  const firstOpen = progress.find((p) => !p.complete)?.step.key ?? 'review';
  const requested = params.get('step');
  const current: StepKey = isStepKey(requested) ? requested : firstOpen;
  const index = STEPS.findIndex((s) => s.key === current);
  const here = progress[index]!;
  const total = overall(app);
  const minutesLeft = progress.filter((p) => !p.complete).reduce((m, p) => m + p.step.minutes, 0);
  const lastRequest = app.status === 'MORE_INFORMATION_REQUIRED' ? app.reviews.find((r) => r.action === 'INFORMATION_REQUESTED') : undefined;

  function go(k: StepKey) {
    router.replace(`${pathname}?step=${k}`, { scroll: false });
  }
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)]!.key);
  const back = () => go(STEPS[Math.max(index - 1, 0)]!.key);

  // Bring the new step into view (the stepper stays where it is on large screens).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After the new step has rendered; a smooth scroll would be cut short by the content swap.
    const id = requestAnimationFrame(() => top.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(id);
  }, [current]);

  const selfSaving = current === 'business' || current === 'activity';

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden shadow-none">
        <CardContent className="from-primary/[0.07] flex flex-col gap-5 bg-gradient-to-br to-transparent p-6 sm:flex-row sm:items-center">
          <ProgressRing percent={total.percent} />
          <div className="flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Activate {app.name}</h1>
              <StatusBadge status={app.status} />
            </div>
            <p className="text-muted-foreground text-sm">
              {total.done === total.total
                ? 'Everything is in place. Review your application and submit it.'
                : `${total.done} of ${total.total} items done. Your progress is saved as you go, so you can come back any time.`}
            </p>
          </div>
          {minutesLeft > 0 && (
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs whitespace-nowrap">
              <Clock className="size-3.5" /> About {minutesLeft} min left
            </div>
          )}
        </CardContent>
      </Card>

      {lastRequest && (
        <Alert className="border-warning/50 bg-warning-muted/40">
          <MessageSquareWarning />
          <AlertTitle>Our compliance team needs a few changes</AlertTitle>
          <AlertDescription>
            <p>{lastRequest.reason}</p>
            {lastRequest.notes && <p className="mt-1">{lastRequest.notes}</p>}
            <p className="mt-2 text-xs">Update the steps below, then resubmit from Review and submit.</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-20">
            <Stepper progress={progress} current={current} onSelect={go} />
          </div>
        </aside>

        <section ref={top} className="min-w-0 scroll-mt-6 space-y-5">
          <MobileStepper progress={progress} index={index} onSelect={go} />
          <header className="space-y-2">
            <p className="text-primary text-xs font-semibold tracking-wide uppercase">Step {index + 1} of {STEPS.length}</p>
            <h2 className="text-2xl font-semibold tracking-tight">{here.step.title}</h2>
            <p className="text-muted-foreground text-sm">{here.step.description}</p>
            {here.items.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 pt-1">
                {here.items.map((r) => (
                  <li
                    key={r.key}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                      r.satisfied ? 'border-success/30 bg-success-muted text-success' : 'text-muted-foreground',
                    )}
                  >
                    {r.satisfied && <Check className="size-3" />} {r.label}
                  </li>
                ))}
              </ul>
            )}
          </header>

          <div key={current} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            {current === 'business' && (
              <ProfileForm
                key={app.version}
                app={app}
                readOnly={!canEdit}
                sections={['identity', 'address']}
                title="Business identity"
                description="As shown on your PAN and registration documents."
                onSaved={canEdit ? next : undefined}
              />
            )}
            {current === 'activity' && (
              <ProfileForm
                key={app.version}
                app={app}
                readOnly={!canEdit}
                sections={['business', 'volumes', 'contact']}
                title="Business activity"
                description="Helps us set the right limits and pricing for you."
                onSaved={canEdit ? next : undefined}
              />
            )}
            {current === 'people' && <PeopleSection app={app} canEdit={canEdit} />}
            {current === 'bank' && <BankAccountsSection app={app} canEdit={canEdit} />}
            {current === 'documents' && (
              <div className="space-y-5">
                <RequiredDocuments app={app} canUpload={canUpload} />
                {app.documents.some((d) => d.type !== 'AGREEMENT') && (
                  <DocumentsSection app={app} canUpload={false} excludeType="AGREEMENT" title="Everything you’ve uploaded" description="Including earlier and rejected uploads." />
                )}
              </div>
            )}
            {current === 'review' && <ReviewStep app={app} progress={progress} canEdit={canEdit} canUpload={canUpload} onEdit={go} />}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t pt-5">
            <Button variant="ghost" onClick={back} disabled={index === 0}>
              <ArrowLeft /> Back
            </Button>
            {current !== 'review' && (!selfSaving || !canEdit) && (
              <Button onClick={next} variant={here.complete ? 'default' : 'outline'}>
                {here.complete ? 'Continue' : 'Skip for now'} <ArrowRight />
              </Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}

/** Merchant onboarding: a guided wizard while the application is editable, then its review status. */
export function OnboardingWizard() {
  const { data: me } = useMe();
  const isMerchant = me?.organization.type === 'MERCHANT';
  const merchant = useMerchant(isMerchant ? me.organization.id : undefined);

  if (me && !isMerchant) return <ErrorState title="Not available" message="Onboarding applies to merchant accounts." />;
  if (!me || merchant.isPending) return <LoadingSkeleton rows={8} />;
  if (merchant.isError) return <ErrorState message={errorMessage(merchant.error)} onRetry={() => void merchant.refetch()} />;

  const app = merchant.data;
  return <div className="mx-auto max-w-6xl">{isEditableStatus(app.status) ? <Wizard app={app} /> : <StatusView app={app} />}</div>;
}
