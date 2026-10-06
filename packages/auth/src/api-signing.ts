import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const API_SIGNATURE_TOLERANCE_SECONDS = 300;

/** sha256 hex of the exact request body bytes (empty body → hash of ""). */
export function bodyHash(rawBody: Buffer | string | undefined): string {
  return createHash('sha256').update(rawBody ?? '').digest('hex');
}

/** A nonce is 16–64 URL-safe characters, unique per request (a UUID works). */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The string an API client signs (docs/API.md):
 *   `${timestamp}.${nonce}.${METHOD}.${pathWithQuery}.${sha256hex(rawBody)}`
 * Method upper-case; path exactly as sent on the request line (including the query string). The
 * nonce makes two otherwise identical requests distinct, so replay protection never blocks
 * legitimate repeats (e.g. polling).
 */
export function canonicalApiString(timestamp: number | string, nonce: string, method: string, pathWithQuery: string, rawBody: Buffer | string | undefined): string {
  return `${timestamp}.${nonce}.${method.toUpperCase()}.${pathWithQuery}.${bodyHash(rawBody)}`;
}

export function signApiRequest(secret: string, timestamp: number | string, nonce: string, method: string, pathWithQuery: string, rawBody?: Buffer | string): string {
  return `v1=${createHmac('sha256', secret).update(canonicalApiString(timestamp, nonce, method, pathWithQuery, rawBody)).digest('hex')}`;
}

/** Constant-time check of a `v1=<hex>` signature header. */
export function verifyApiSignature(secret: string, header: string, timestamp: number | string, nonce: string, method: string, pathWithQuery: string, rawBody?: Buffer | string): boolean {
  const expected = Buffer.from(signApiRequest(secret, timestamp, nonce, method, pathWithQuery, rawBody));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
