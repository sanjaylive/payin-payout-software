import { createHash, timingSafeEqual } from 'node:crypto';
import { httpJson, type HttpRequest } from '../http/client';
import { ProviderError } from '../interfaces/errors';
import type { HealthCheckResult, PaymentProviderStatus, ProviderContext } from '../interfaces/types';

/** Paise → "1234.50" (gateways take rupee strings or numbers with two decimals). */
export function rupees(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** "1234.5" / 1234.5 / "1234.50" → 123450n, without floating point. */
export function toMinor(value: string | number | undefined | null): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const s = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  const m = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) return undefined;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export const sha512 = (s: string) => createHash('sha512').update(s, 'utf8').digest('hex');
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Constant-time comparison of two strings (hex/base64 signatures). */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function requireCredentials<K extends string>(ctx: ProviderContext, keys: readonly K[]): Record<K, string> {
  const missing = keys.filter((k) => !ctx.credentials[k]);
  if (missing.length) throw new ProviderError('CONFIGURATION', 'MISSING_CREDENTIALS', `${ctx.providerCode}: missing credentials ${missing.join(', ')}`, ctx.providerCode);
  return Object.fromEntries(keys.map((k) => [k, ctx.credentials[k]!])) as Record<K, string>;
}

/** The gateway's sandbox or production host; `config.base_url` overrides (tests, private endpoints). */
export function baseUrl(ctx: ProviderContext, test: string, live: string, key = 'base_url'): string {
  const override = ctx.config[key];
  if (typeof override === 'string' && override) return override;
  return ctx.environment === 'LIVE' ? live : test;
}

export function call<T>(ctx: ProviderContext, req: Omit<HttpRequest, 'providerCode' | 'timeoutMs' | 'requestId'>) {
  return httpJson<T>({ ...req, providerCode: ctx.providerCode, timeoutMs: ctx.timeoutMs, requestId: ctx.requestId });
}

export function unknownStatus(ctx: ProviderContext, value: unknown): never {
  throw new ProviderError('AMBIGUOUS', 'UNKNOWN_STATUS', `${ctx.providerCode}: unrecognised status "${String(value)}"`, ctx.providerCode);
}

export function mapStatus(ctx: ProviderContext, map: Record<string, PaymentProviderStatus>, value: unknown): PaymentProviderStatus {
  const s = typeof value === 'string' ? map[value.toLowerCase()] : undefined;
  return s ?? unknownStatus(ctx, value);
}

export function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name.toLowerCase()] ?? headers[name];
}

/** Parse an `application/x-www-form-urlencoded` webhook body. */
export function formBody(raw: Buffer): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}

export async function timedHealth(fn: () => Promise<unknown>): Promise<HealthCheckResult> {
  const started = Date.now();
  await fn();
  return { ok: true, latencyMs: Date.now() - started };
}

/** Our payment id without separators, for gateways that reject `_` or limit order-id length. */
export function compactRef(reference: string, maxLength = 30): string {
  const plain = reference.replace(/[^A-Za-z0-9]/g, '');
  return plain.length <= maxLength ? plain : plain.slice(plain.length - maxLength);
}

export function notSupported(ctx: ProviderContext, what: string): never {
  throw new ProviderError('CONFIGURATION', 'NOT_SUPPORTED', `${ctx.providerCode}: ${what} is not supported by this gateway`, ctx.providerCode);
}

/** Inverse of compactRef for untruncated ids: "rfnd01H…" → "rfnd_01H…". */
export function restoreRef(compact: string | undefined): string | undefined {
  const m = compact ? /^([a-z]{2,5})([0-9A-HJKMNP-TV-Z]{26})$/.exec(compact) : null;
  return m ? `${m[1]}_${m[2]}` : undefined;
}
