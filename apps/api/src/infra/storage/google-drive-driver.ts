import { createSign } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { googleDriveConfigSchema, googleDriveSecretSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { type StorageCheck, type StorageDriver, StorageDriverError, timed } from './driver';

type Config = z.output<typeof googleDriveConfigSchema>;
type Secret = z.output<typeof googleDriveSecretSchema>;

/** Google endpoints. Fixed — never taken from the uploaded key file — so a key cannot redirect tokens. */
export interface GoogleUrls {
  token: string;
  api: string;
  upload: string;
}
const GOOGLE: GoogleUrls = { token: 'https://oauth2.googleapis.com/token', api: 'https://www.googleapis.com/drive/v3', upload: 'https://www.googleapis.com/upload/drive/v3' };
const SCOPE = 'https://www.googleapis.com/auth/drive';
/** Resumable-upload chunk: a multiple of 256 KiB. Memory per upload is bounded by this. */
const CHUNK = 8 * 1024 * 1024;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google Drive through a service account (docs/FILE_STORAGE.md §3.2). Files go into one folder,
 * which should be inside a Shared Drive: service accounts have no Drive storage of their own.
 * Uses the Drive v3 REST API directly (JWT bearer grant signed with node:crypto, resumable uploads).
 */
export class GoogleDriveStorageDriver implements StorageDriver {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: Config,
    private readonly secret: Secret | null,
    private readonly urls: GoogleUrls = GOOGLE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get serviceAccount(): string | null {
    return this.secret?.client_email ?? null;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.secret) throw new StorageDriverError('Upload the service account key first');
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT', ...(this.secret.private_key_id ? { kid: this.secret.private_key_id } : {}) })}.${enc({
      iss: this.secret.client_email,
      scope: SCOPE,
      aud: this.urls.token,
      iat: now,
      exp: now + 3600,
      ...(this.config.impersonate_user ? { sub: this.config.impersonate_user } : {}),
    })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(this.secret.private_key, 'base64url');
    } catch {
      throw new StorageDriverError('The private key in the service account file is not valid');
    }
    const res = await this.call(this.urls.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      if (json.error === 'invalid_grant') throw new StorageDriverError('Google rejected the key: it may have been deleted or disabled, or the server clock is wrong');
      if (json.error === 'unauthorized_client') throw new StorageDriverError('Domain-wide delegation is not set up for this service account (needed to act as a user)');
      throw new StorageDriverError(`Google sign-in failed${json.error ? ` (${json.error})` : ''}`, res.status >= 500);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
    } catch (err) {
      throw new StorageDriverError(`Cannot reach Google (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'})`, true);
    }
  }

  private async authed(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.accessToken()}`);
    return this.call(url, { ...init, headers });
  }

  async put(name: string, body: Readable): Promise<string> {
    const fileName = name.replace(/\//g, '_');
    const start = await this.authed(`${this.urls.upload}/files?uploadType=resumable&supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream' },
      body: JSON.stringify({ name: fileName, parents: [this.config.folder_id], mimeType: 'application/octet-stream', appProperties: { pay2all: '1' } }),
    });
    if (!start.ok) throw await this.explain(start);
    const session = start.headers.get('location');
    if (!session) throw new StorageDriverError('Google did not start the upload');

    // Send fixed-size chunks; the last one carries the total. Holding back one chunk tells us which is last.
    let buf = Buffer.alloc(0);
    let offset = 0;
    let fileId: string | null = null;
    const send = async (chunk: Buffer, last: boolean) => {
      const end = offset + chunk.length - 1;
      const range = chunk.length === 0 ? `bytes */${offset}` : `bytes ${offset}-${end}/${last ? offset + chunk.length : '*'}`;
      const res = await this.call(session, { method: 'PUT', headers: { 'Content-Range': range, 'Content-Length': String(chunk.length) }, body: chunk, timeoutMs: 120_000 });
      if (last) {
        if (!res.ok) throw await this.explain(res);
        fileId = ((await res.json()) as { id?: string }).id ?? null;
      } else if (res.status !== 308) {
        throw await this.explain(res);
      }
      offset += chunk.length;
    };
    try {
      for await (const part of body) {
        buf = Buffer.concat([buf, part as Buffer]);
        while (buf.length > CHUNK) {
          await send(buf.subarray(0, CHUNK), false);
          buf = buf.subarray(CHUNK);
        }
      }
      await send(buf, true);
    } catch (err) {
      // Abandon the session so no partial file is left behind.
      await this.call(session, { method: 'DELETE' }).catch(() => undefined);
      throw err instanceof StorageDriverError ? err : new StorageDriverError('Upload to Google Drive failed', true);
    }
    if (!fileId) throw new StorageDriverError('Google did not return a file id');
    return fileId;
  }

  async get(locator: string): Promise<Readable> {
    const res = await this.authed(`${this.urls.api}/files/${encodeURIComponent(locator)}?alt=media&supportsAllDrives=true`, { timeoutMs: 120_000 });
    if (!res.ok || !res.body) throw await this.explain(res);
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }

  async delete(locator: string): Promise<void> {
    const res = await this.authed(`${this.urls.api}/files/${encodeURIComponent(locator)}?supportsAllDrives=true`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await this.explain(res);
  }

  async precheck(): Promise<StorageCheck[]> {
    const checks: StorageCheck[] = [];
    try {
      const { ms } = await timed(() => this.accessToken());
      checks.push({ name: 'Service account sign-in', ok: true, detail: this.secret?.client_email, ms });
    } catch (err) {
      return [{ name: 'Service account sign-in', ok: false, detail: (err as Error).message }];
    }
    const { value: res, ms } = await timed(() =>
      this.authed(`${this.urls.api}/files/${encodeURIComponent(this.config.folder_id)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,capabilities(canAddChildren)`),
    );
    if (!res.ok) {
      checks.push({ name: 'Folder access', ok: false, detail: (await this.explain(res)).message });
      return checks;
    }
    const f = (await res.json()) as { name: string; mimeType: string; driveId?: string; capabilities?: { canAddChildren?: boolean } };
    if (f.mimeType !== FOLDER_MIME) {
      checks.push({ name: 'Folder access', ok: false, detail: `“${f.name}” is a file, not a folder` });
      return checks;
    }
    const canAdd = f.capabilities?.canAddChildren !== false;
    checks.push({
      name: 'Folder access',
      ok: canAdd,
      detail: canAdd ? `“${f.name}”` : `“${f.name}” is shared read-only — give ${this.secret?.client_email} Content manager (or Editor) access`,
      ms,
    });
    // Without a Shared Drive a service account has 0 bytes of quota; impersonating a user uses theirs.
    const shared = Boolean(f.driveId) || Boolean(this.config.impersonate_user);
    checks.push({
      name: 'Storage quota',
      ok: shared,
      detail: f.driveId ? 'Folder is in a Shared Drive' : this.config.impersonate_user ? `Uses ${this.config.impersonate_user}’s storage` : 'Folder is in a personal My Drive: service accounts have no storage there. Move it into a Shared Drive.',
    });
    return checks;
  }

  private async explain(res: Response): Promise<StorageDriverError> {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    const reason = json.error?.errors?.[0]?.reason;
    const sa = this.secret?.client_email ?? 'the service account';
    switch (reason) {
      case 'storageQuotaExceeded':
        return new StorageDriverError('No Drive storage: service accounts need a folder inside a Shared Drive');
      case 'notFound':
        return new StorageDriverError(`Not found — or not shared with ${sa}`);
      case 'insufficientFilePermissions':
      case 'forbidden':
        return new StorageDriverError(`${sa} cannot write to this folder: share it as Content manager or Editor`);
      case 'accessNotConfigured':
        return new StorageDriverError('The Google Drive API is not enabled for this Google Cloud project');
      case 'rateLimitExceeded':
      case 'userRateLimitExceeded':
        return new StorageDriverError('Google Drive rate limit reached; try again shortly', true);
      default:
        if (res.status === 404) return new StorageDriverError(`Not found — or not shared with ${sa}`);
        if (res.status === 401) return new StorageDriverError('Google rejected the access token');
        if (res.status === 403) return new StorageDriverError(json.error?.message?.slice(0, 200) ?? 'Google Drive denied access');
        return new StorageDriverError(`Google Drive error ${res.status}`, res.status >= 500 || res.status === 429);
    }
  }
}
