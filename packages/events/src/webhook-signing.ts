import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'Pay2All-Signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * Reference verifier (the same algorithm merchants implement; see docs/WEBHOOKS.md). Rejects stale
 * timestamps (replay window) and compares in constant time. Several v1 values are allowed so a
 * secret rotation can sign with old and new secrets during the overlap.
 */
export function verifyWebhookSignature(secret: string, header: string | undefined, rawBody: string, now = Math.floor(Date.now() / 1000), tolerance = WEBHOOK_TOLERANCE_SECONDS): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isInteger(t) || Math.abs(now - t) > tolerance || !sigs.length) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}

/** Retry schedule after a failed attempt n (1-based): ~2 days of retries in total. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
