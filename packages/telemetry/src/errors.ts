import * as Sentry from '@sentry/node-core';

/**
 * Sentry-compatible error reporting (docs/OBSERVABILITY.md §4). Off unless SENTRY_DSN is set; works
 * with Sentry or any Sentry-protocol server (GlitchTip, self-hosted). Only unexpected errors are
 * reported (5xx, crashed jobs) — never business rejections. Events are scrubbed before sending:
 * no request bodies, headers, cookies, query strings or user data leave the process.
 */
export interface ErrorReportingOptions {
  dsn: string | undefined;
  service: string;
  environment: string;
  release?: string;
}

let enabled = false;

const SENSITIVE_KEY = /pass|secret|token|otp|authorization|cookie|account|card|pan|aadhaar|signature|api[-_]?key/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  return out;
}

/** Exported for tests: strip everything that could carry personal or secret data. */
export function scrubEvent<E extends Sentry.Event>(event: E): E {
  if (event.request) event.request = { method: event.request.method, url: event.request.url?.split('?')[0] };
  delete event.user;
  delete event.breadcrumbs;
  if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrub(event.contexts) as Sentry.Event['contexts'];
  return event;
}

export function initErrorReporting(opts: ErrorReportingOptions): boolean {
  if (!opts.dsn) return false;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    serverName: opts.service,
    sendDefaultPii: false,
    // No auto-instrumentation (OpenTelemetry owns that); errors are reported explicitly.
    defaultIntegrations: false,
    // Errors only; traces go to OpenTelemetry.
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    initialScope: { tags: { service: opts.service } },
    beforeSend: (event) => scrubEvent(event),
  });
  enabled = true;
  return true;
}

export function reportError(err: unknown, context: { requestId?: string; route?: string; job?: string; tags?: Record<string, string> } = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag('request_id', context.requestId);
    if (context.route) scope.setTag('route', context.route);
    if (context.job) scope.setTag('job', context.job);
    for (const [k, v] of Object.entries(context.tags ?? {})) scope.setTag(k, v);
    Sentry.captureException(err);
  });
}

export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
