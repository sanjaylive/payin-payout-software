import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../interfaces/errors';

/** Error codes that prove the request never left this host. */
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

export interface HttpRequest {
  providerCode: string;
  baseUrl: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  requestId: string;
  /** Optional HMAC signing: X-Timestamp + X-Signature over `${ts}.${METHOD}.${path}.${sha256(body)}`. */
  signing?: { keyId: string; secret: string; keyHeader: string; signatureHeader: string; timestampHeader: string };
}

export interface HttpResponse<T> {
  status: number;
  body: T;
  latencyMs: number;
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

/**
 * JSON-over-HTTP call with classification into the provider error taxonomy:
 *  - DNS/refused/TLS errors before sending → NOT_ATTEMPTED (safe to fail over)
 *  - timeout / reset / anything after the request may have been received → AMBIGUOUS
 *  - 401/403 → CONFIGURATION, 429 → NOT_ATTEMPTED, other 4xx → REJECTED, 5xx → AMBIGUOUS
 *  - non-JSON 2xx → AMBIGUOUS (we can't know what happened)
 */
export async function httpJson<T>(req: HttpRequest): Promise<HttpResponse<T>> {
  const payload = req.body === undefined ? '' : JSON.stringify(req.body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': req.requestId,
    ...(payload ? { 'Content-Type': 'application/json' } : {}),
    ...req.headers,
  };
  if (req.signing) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const digest = createHash('sha256').update(payload).digest('hex');
    headers[req.signing.keyHeader] = req.signing.keyId;
    headers[req.signing.timestampHeader] = ts;
    headers[req.signing.signatureHeader] = createHmac('sha256', req.signing.secret).update(`${ts}.${req.method}.${req.path}.${digest}`).digest('hex');
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(new URL(req.path, req.baseUrl), {
      method: req.method,
      headers,
      body: payload || undefined,
      signal: AbortSignal.timeout(req.timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const code = errorCode(err);
    // fetch rejects bad URLs / blocked ports before opening any connection (as a bare TypeError, or
    // "fetch failed" wrapping a code-less cause, depending on the undici version).
    const detail = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message ?? '';
    if (!code && /bad port|invalid url|unsupported protocol|failed to parse url/i.test(detail)) {
      throw new ProviderError('CONFIGURATION', 'INVALID_ENDPOINT', `${req.providerCode} endpoint is invalid: ${detail}`, req.providerCode);
    }
    if (code && PRE_SEND_CODES.has(code)) {
      throw new ProviderError('NOT_ATTEMPTED', code, `Could not reach ${req.providerCode} (${code})`, req.providerCode);
    }
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError('AMBIGUOUS', timedOut ? 'TIMEOUT' : (code ?? 'NETWORK_ERROR'), `${req.providerCode} ${timedOut ? 'timed out' : 'connection failed'} after sending`, req.providerCode);
  }

  const latencyMs = Date.now() - started;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ProviderError('AMBIGUOUS', 'MALFORMED_RESPONSE', `${req.providerCode} returned a non-JSON success response`, req.providerCode, res.status);
    body = { raw: text.slice(0, 200) };
  }

  if (res.ok) return { status: res.status, body: body as T, latencyMs };
  const providerCode = (body as { code?: string; error?: { code?: string } })?.error?.code ?? (body as { code?: string })?.code ?? `HTTP_${res.status}`;
  const message = `${req.providerCode} responded ${res.status} (${providerCode})`;
  if (res.status === 401 || res.status === 403) throw new ProviderError('CONFIGURATION', providerCode, message, req.providerCode, res.status);
  if (res.status === 429) throw new ProviderError('NOT_ATTEMPTED', 'RATE_LIMITED', message, req.providerCode, res.status);
  if (res.status === 408 || res.status >= 500) throw new ProviderError('AMBIGUOUS', providerCode, message, req.providerCode, res.status);
  throw new ProviderError('REJECTED', providerCode, message, req.providerCode, res.status);
}

/** Constant-time HMAC check for inbound webhooks. */
export function verifyHmac(secret: string, payload: Buffer | string, signatureHex: string | undefined): boolean {
  if (!signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signatureHex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
