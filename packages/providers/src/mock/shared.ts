import { createHash } from 'node:crypto';
import { ProviderError } from '../interfaces/errors';
import type { HealthCheckResult, NormalizedWebhookEvent, ProviderContext, WebhookVerification } from '../interfaces/types';
import { verifyHmac } from '../http/client';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Creation time embedded in our prefixed ULID ids (pay_…, att_…). */
export function ulidTime(id: string): number {
  const ulid = id.slice(id.indexOf('_') + 1);
  let ms = 0;
  for (const ch of ulid.slice(0, 10)) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new ProviderError('REJECTED', 'INVALID_REFERENCE', 'Reference is not a ULID-based id');
    ms = ms * 32 + v;
  }
  return ms;
}

export const paise = (amountMinor: bigint) => Number(amountMinor % 100n);
export const digits = (seed: string, n: number) => BigInt(`0x${createHash('sha256').update(seed).digest('hex').slice(0, 15)}`).toString().padStart(n, '0').slice(-n);

/** Read a string/number config value safely (config is untyped JSON). */
export function cfg(ctx: ProviderContext, key: string, fallback: string): string {
  const v = ctx.config[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
}

export function settings(ctx: ProviderContext) {
  return {
    autoSuccessAfterMs: Number(ctx.config.auto_success_after_ms ?? 2_000),
    simulateDown: ctx.config.simulate_down === true,
    latencyMs: Number(ctx.config.latency_ms ?? 0),
  };
}

export async function simulateLatency(ctx: ProviderContext): Promise<void> {
  const { latencyMs, simulateDown } = settings(ctx);
  if (simulateDown) throw new ProviderError('NOT_ATTEMPTED', 'SIMULATED_DOWN', `${ctx.providerCode} is simulating an outage`, ctx.providerCode);
  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
}

export async function mockHealthCheck(ctx: ProviderContext): Promise<HealthCheckResult> {
  const started = Date.now();
  await simulateLatency(ctx);
  return { ok: true, latencyMs: Date.now() - started };
}

/** Mock webhook: header x-mock-signature = hex HMAC-SHA256(webhook_secret, raw body). */
export function verifyMockWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
  const secret = ctx.credentials.webhook_secret;
  if (!secret) return { valid: false, reason: 'webhook_secret not configured' };
  if (!verifyHmac(secret, rawBody, headers['x-mock-signature'])) return { valid: false, reason: 'signature mismatch' };
  let body: { event_id?: string; type?: string; data?: Record<string, string | undefined> };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as typeof body;
  } catch {
    return { valid: false, reason: 'malformed JSON' };
  }
  if (!body.event_id || !body.type || !body.data) return { valid: false, reason: 'missing event fields' };
  const d = body.data;
  const event: NormalizedWebhookEvent = {
    externalEventId: body.event_id,
    type: body.type as NormalizedWebhookEvent['type'],
    reference: d.reference,
    providerOrderId: d.provider_order_id,
    providerReference: d.provider_reference,
    status: d.status ?? 'UNKNOWN',
    amountMinor: d.amount_minor ? BigInt(d.amount_minor) : undefined,
    utr: d.utr,
    rrn: d.rrn,
    payerVpa: d.payer_vpa,
    failureReason: d.failure_reason,
    providerQrId: d.qr_id,
    paidAt: d.paid_at,
  };
  return { valid: true, event };
}
