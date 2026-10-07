'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { ErrorState } from '@pay2all/ui/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

interface SystemSettings {
  environment: string;
  api_environment: 'TEST' | 'LIVE';
  release: string | null;
  security: { mfa_enforced_for_staff: boolean; session_idle_minutes: number; max_failed_logins: number; webhook_https_required: boolean; documents_encrypted_at_rest: boolean; swagger_ui_enabled: boolean };
  observability: { tracing: boolean; trace_sample_ratio: number; error_reporting: boolean; metrics_port: number | null; jobs_metrics_port: number | null; metrics_token_required: boolean };
  messaging: { kafka_fast_path: boolean };
  risk: { enabled_rules: number; enforcing_rules: number };
}

const on = (v: boolean, good = true) => <StatusBadge status={v ? 'ON' : 'OFF'} tone={v === good ? 'success' : 'warning'} />;

function Section({ title, description, rows }: { title: string; description: string; rows: [string, ReactNode][] }) {
  return (
    <Card className="shadow-none">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>
        <dl className="divide-y rounded-lg border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-3 py-2"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default function SystemSettingsPage() {
  const q = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<SystemSettings>('/v1/system/settings') });
  const s = q.data;
  return (
    <>
      <PageHeader
        title="System settings"
        description="How this deployment is configured. These values come from the deployment’s environment and change only through a release, so they are read-only here."
      />
      {q.error ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : !s ? (
        <div className="grid gap-4 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section
            title="Deployment"
            description="Environment and which API keys this deployment accepts."
            rows={[
              ['Environment', <span key="e" className="font-mono text-xs">{s.environment}</span>],
              ['API keys accepted', <StatusBadge key="k" status={s.api_environment === 'LIVE' ? 'LIVE' : 'TEST'} tone={s.api_environment === 'LIVE' ? 'primary' : 'info'} />],
              ['Release', <span key="r" className="font-mono text-xs">{s.release ?? '—'}</span>],
              ['Kafka fast path for payouts', on(s.messaging.kafka_fast_path)],
            ]}
          />
          <Section
            title="Security"
            description="Staff sign-in and data-protection settings."
            rows={[
              ['MFA required for platform staff', on(s.security.mfa_enforced_for_staff)],
              ['Idle session timeout', `${s.security.session_idle_minutes} min`],
              ['Failed sign-ins before lockout', String(s.security.max_failed_logins)],
              ['Merchant webhooks must use HTTPS', on(s.security.webhook_https_required)],
              ['KYC documents encrypted at rest (SSE)', on(s.security.documents_encrypted_at_rest)],
              ['Public Swagger UI', on(s.security.swagger_ui_enabled, false)],
            ]}
          />
          <Section
            title="Observability"
            description="Traces, metrics and error reporting (docs/OBSERVABILITY.md)."
            rows={[
              ['OpenTelemetry tracing', s.observability.tracing ? <span key="t">{on(true)} <span className="text-muted-foreground ml-1 text-xs">{Math.round(s.observability.trace_sample_ratio * 100)}% sampled</span></span> : on(false)],
              ['Error reporting (Sentry protocol)', on(s.observability.error_reporting)],
              ['Prometheus metrics (API / jobs)', `${s.observability.metrics_port ?? 'off'} / ${s.observability.jobs_metrics_port ?? 'off'}`],
              ['Metrics scrape token', on(s.observability.metrics_token_required)],
            ]}
          />
          <Section
            title="Risk"
            description="Rules are configured under Risk → Rules."
            rows={[
              ['Enabled rules', String(s.risk.enabled_rules)],
              ['Enforcing (others monitor only)', String(s.risk.enforcing_rules)],
              ['Manage rules', <Link key="l" href="/admin/risk/rules" className="text-primary text-sm underline-offset-4 hover:underline">Open risk rules</Link>],
              ['Your sign-in security', <Link key="s" href="/admin/settings/security" className="text-primary text-sm underline-offset-4 hover:underline">MFA &amp; sessions</Link>],
            ]}
          />
        </div>
      )}
    </>
  );
}
