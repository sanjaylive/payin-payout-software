'use client';

import { ActivityTimeline } from '@pay2all/ui/components/timeline';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { cn } from '@pay2all/ui/lib/utils';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { ArrowRight, Ban, Check, Code2, FileSearch, Hourglass, type LucideIcon, PartyPopper, QrCode, Users, Wallet, XCircle } from 'lucide-react';
import Link from 'next/link';
import type { MerchantApplication, MerchantStatus } from '@/lib/api/types';
import { REVIEW_ACTION_LABELS } from '../merchants/labels';
import { RequirementList } from '../merchants/requirements-panel';

const HERO: Partial<Record<MerchantStatus, { icon: LucideIcon; tone: string; title: string; body: string }>> = {
  SUBMITTED: { icon: Hourglass, tone: 'bg-primary/10 text-primary', title: 'Application submitted', body: 'You’re in the compliance queue. We’ll email you as soon as a reviewer picks it up, usually within one working day.' },
  UNDER_REVIEW: { icon: FileSearch, tone: 'bg-primary/10 text-primary', title: 'Under review', body: 'A compliance reviewer is checking your details and documents. If anything is missing we’ll ask here and by email.' },
  APPROVED: { icon: PartyPopper, tone: 'bg-success-muted text-success', title: 'You’re approved', body: 'Your business is verified. Here’s how to start collecting and paying out.' },
  REJECTED: { icon: XCircle, tone: 'bg-destructive/10 text-destructive', title: 'Application not approved', body: 'We couldn’t approve this application. Your account manager can explain why and what options you have.' },
  SUSPENDED: { icon: Ban, tone: 'bg-warning-muted text-warning-foreground', title: 'Account suspended', body: 'Payments and payouts are paused. Contact support to resolve this.' },
};

const TRACK: { status: MerchantStatus[]; label: string }[] = [
  { status: ['DRAFT', 'MORE_INFORMATION_REQUIRED'], label: 'Application' },
  { status: ['SUBMITTED'], label: 'Submitted' },
  { status: ['UNDER_REVIEW'], label: 'In review' },
  { status: ['APPROVED', 'SUSPENDED'], label: 'Approved' },
];

const NEXT: { href: string; icon: LucideIcon; title: string; body: string }[] = [
  { href: '/payin/create', icon: QrCode, title: 'Collect your first payment', body: 'Create a UPI QR or payment link and watch it settle in your ledger.' },
  { href: '/developers/api-keys', icon: Code2, title: 'Integrate the API', body: 'Generate keys, set up webhooks and go live from your own checkout.' },
  { href: '/team', icon: Users, title: 'Invite your team', body: 'Give finance and developers their own sign-ins with the right roles.' },
  { href: '/accounts/balance', icon: Wallet, title: 'Balances and settlements', body: 'See what’s available, pending and on its way to your bank.' },
];

function Tracker({ status }: { status: MerchantStatus }) {
  const at = TRACK.findIndex((t) => t.status.includes(status));
  const failed = status === 'REJECTED';
  return (
    <ol className="flex items-center gap-2">
      {TRACK.map((t, i) => {
        const done = !failed && i < at;
        const current = !failed && i === at;
        return (
          <li key={t.label} className="flex flex-1 items-center gap-2 last:flex-none">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  done && 'border-success bg-success text-success-foreground',
                  current && (status === 'APPROVED' ? 'border-success bg-success text-success-foreground' : 'border-primary text-primary'),
                  !done && !current && 'border-muted text-muted-foreground',
                )}
              >
                {done || (current && status === 'APPROVED') ? <Check className="size-4" /> : i + 1}
              </span>
              <span className={cn('hidden text-sm sm:inline', current ? 'font-medium' : 'text-muted-foreground')}>{t.label}</span>
            </span>
            {i < TRACK.length - 1 && <span className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-success' : 'bg-muted')} />}
          </li>
        );
      })}
    </ol>
  );
}

/** After submission: where the application stands, what compliance checks, the history, and (once approved) next steps. */
export function StatusView({ app }: { app: MerchantApplication }) {
  const hero = HERO[app.status] ?? HERO.SUBMITTED!;
  const Icon = hero.icon;
  const approval = app.requirements.filter((r) => r.stage === 'APPROVAL');
  const verified = approval.filter((r) => r.satisfied).length;

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden shadow-none">
        <div className="from-primary/5 bg-gradient-to-br to-transparent p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <span className={cn('flex size-14 shrink-0 items-center justify-center rounded-2xl', hero.tone)}>
              <Icon className="size-7" />
            </span>
            <div className="flex-1 space-y-1.5">
              <h2 className="text-xl font-semibold tracking-tight">{hero.title}</h2>
              <p className="text-muted-foreground max-w-2xl text-sm">{hero.body}</p>
              {app.submitted_at && <p className="text-muted-foreground text-xs">Submitted {formatDateTime(app.submitted_at)}{app.approved_at && ` · approved ${formatDateTime(app.approved_at)}`}</p>}
            </div>
          </div>
          <div className="mt-8"><Tracker status={app.status} /></div>
        </div>
      </Card>

      {app.status === 'APPROVED' && (
        <div className="grid gap-4 sm:grid-cols-2">
          {NEXT.map(({ href, icon: I, title, body }) => (
            <Link key={href} href={href} className="group hover:border-primary/50 hover:bg-primary/5 flex items-start gap-4 rounded-xl border p-5 transition-colors">
              <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg"><I className="size-5" /></span>
              <span className="flex-1">
                <span className="flex items-center gap-1 font-medium">{title} <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" /></span>
                <span className="text-muted-foreground mt-0.5 block text-sm">{body}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {app.status !== 'APPROVED' && app.status !== 'REJECTED' && (
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                What we’re checking <span className="text-muted-foreground text-xs font-normal tabular-nums">{verified}/{approval.length} done</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RequirementList items={approval} />
              <p className="text-muted-foreground mt-4 text-xs">
                Need to send the signed agreement or a replacement document? Use <Link className="text-primary hover:underline" href="/compliance/agreement">Agreement</Link> or{' '}
                <Link className="text-primary hover:underline" href="/compliance/documents">Documents</Link> once a reviewer asks.
              </p>
            </CardContent>
          </Card>
        )}
        <Card className={cn('shadow-none', (app.status === 'APPROVED' || app.status === 'REJECTED') && 'lg:col-span-2')}>
          <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
          <CardContent>
            <ActivityTimeline
              items={app.reviews.map((r) => ({
                id: r.id,
                title: REVIEW_ACTION_LABELS[r.action] ?? r.action,
                description: [r.reason, r.notes].filter(Boolean).join(' — ') || undefined,
                timestamp: r.reviewed_at,
                tone: r.action === 'APPROVED' ? 'success' : r.action === 'REJECTED' || r.action === 'SUSPENDED' ? 'danger' : r.action === 'INFORMATION_REQUESTED' ? 'warning' : 'default',
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
