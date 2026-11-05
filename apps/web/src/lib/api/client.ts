import type { ApiFailure, ApiSuccess, PaginationMeta } from '@pay2all/types';
import { useAuthStore } from '../auth/store';
import { requestStepUp } from '../auth/step-up';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Normalised API error carrying the server's error code and request id for support/debugging. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Attach the bearer token and transparently refresh once on expiry (default true). */
  auth?: boolean;
  /** Extra request headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>;
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function parse<T>(res: Response): Promise<ApiSuccess<T, PaginationMeta>> {
  const body = (await res.json().catch(() => null)) as ApiSuccess<T, PaginationMeta> | ApiFailure | null;
  if (!body) throw new ApiError(res.status, 'INTERNAL_ERROR', 'Unexpected response from server');
  if (!body.success) {
    throw new ApiError(res.status, body.error.code, body.error.message, body.error.request_id, body.error.details);
  }
  return body;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Rotate the refresh cookie for a new access token. Single-flight: concurrent 401s share one
 * refresh call, because refresh tokens are single-use and parallel reuse would revoke the session.
 */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(buildUrl('/v1/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Pay2All-CSRF': '1' },
      });
      if (!res.ok) {
        useAuthStore.getState().clear();
        return false;
      }
      const body = await parse<{ access_token: string }>(res);
      useAuthStore.getState().setAccessToken(body.data.access_token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshInFlight = null), 0);
    }
  })();
  return refreshInFlight;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const token = useAuthStore.getState().accessToken;
  return fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.auth !== false && token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function sendForm(path: string, form: FormData): Promise<Response> {
  const token = useAuthStore.getState().accessToken;
  return fetch(buildUrl(path), { method: 'POST', credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
}

/** True when the API asks for a fresh identity confirmation (docs/SECURITY.md §1.9). */
async function needsStepUp(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.clone().json().catch(() => null)) as ApiFailure | null;
  return body?.error?.code === 'STEP_UP_REQUIRED';
}

/** Multipart upload (KYC documents). The browser sets the multipart boundary. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  let res = await sendForm(path, form);
  if (res.status === 401 && (await refreshSession())) res = await sendForm(path, form);
  if ((await needsStepUp(res)) && (await requestStepUp())) res = await sendForm(path, form);
  return (await parse<T>(res)).data;
}

/** Authenticated file download: fetch with the bearer token, then save via a temporary blob URL. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const get = () => fetch(buildUrl(path), { credentials: 'include', headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken ?? ''}` } });
  let res = await get();
  if (res.status === 401 && (await refreshSession())) res = await get();
  if (!res.ok) await parse(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Authenticated binary fetch (e.g. an uploaded image shown with an object URL). */
export async function apiBlob(path: string): Promise<Blob> {
  const get = () => fetch(buildUrl(path), { credentials: 'include', headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken ?? ''}` } });
  let res = await get();
  if (res.status === 401 && (await refreshSession())) res = await get();
  if (!res.ok) await parse(res);
  return res.blob();
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<ApiSuccess<T, PaginationMeta>> {
  let res = await send(path, opts);
  if (res.status === 401 && opts.auth !== false) {
    if (await refreshSession()) res = await send(path, opts);
  }
  // Sensitive action with a stale confirmation: confirm in the dialog, then retry once.
  if (opts.auth !== false && (await needsStepUp(res)) && (await requestStepUp())) res = await send(path, opts);
  return parse<T>(res);
}

export const api = {
  get: <T>(path: string, query?: Query) => apiRequest<T>(path, { query }).then((r) => r.data),
  list: <T>(path: string, query?: Query) => apiRequest<T[]>(path, { query }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body' | 'method'> = {}) =>
    apiRequest<T>(path, { ...opts, method: 'POST', body: body ?? {} }).then((r) => r.data),
  patch: <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PATCH', body }).then((r) => r.data),
  put: <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PUT', body }).then((r) => r.data),
  delete: <T>(path: string, query?: Query) => apiRequest<T>(path, { method: 'DELETE', query }).then((r) => r.data),
};

/** Cookie-authenticated logout (CSRF header required). Best effort: local state is cleared regardless. */
export async function logout(): Promise<void> {
  try {
    await fetch(buildUrl('/v1/auth/logout'), { method: 'POST', credentials: 'include', headers: { 'X-Pay2All-CSRF': '1' } });
  } finally {
    useAuthStore.getState().clear();
  }
}
