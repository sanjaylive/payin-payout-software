import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleDriveStorageDriver, type GoogleUrls } from './google-drive-driver';

/** A fake of the three Google endpoints the driver uses, verifying what it is sent. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { type: 'service_account' as const, client_email: 'pay2all@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), private_key_id: 'kid123456', project_id: 'proj' };
const FOLDER = '1FolderIdAbCdEfGhIj';

let server: http.Server;
let urls: GoogleUrls;
const files = new Map<string, Buffer>();
const sessions = new Map<string, { parts: Buffer[]; parent: string; name: string }>();
const seen = { tokenRequests: 0, chunkRanges: [] as string[], jwtClaims: null as Record<string, unknown> | null };
let folder: { mimeType: string; driveId?: string; canAddChildren: boolean } = { mimeType: 'application/vnd.google-apps.folder', driveId: '0AShared', canAddChildren: true };

function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://x');
      const data = await body(req);
      const json = (status: number, o: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === '/token') {
        seen.tokenRequests++;
        const assertion = new URLSearchParams(data.toString()).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        const valid = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
        if (!valid) return json(400, { error: 'invalid_grant' });
        seen.jwtClaims = JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>;
        return json(200, { access_token: 'ya29.test', expires_in: 3600 });
      }
      if (req.headers.authorization !== 'Bearer ya29.test' && !url.pathname.startsWith('/session/')) return json(401, { error: { message: 'no auth' } });
      if (url.pathname === `/api/files/${FOLDER}`) {
        return json(200, { id: FOLDER, name: 'Pay2All files', mimeType: folder.mimeType, ...(folder.driveId ? { driveId: folder.driveId } : {}), capabilities: { canAddChildren: folder.canAddChildren } });
      }
      if (url.pathname === '/upload/files' && req.method === 'POST') {
        const meta = JSON.parse(data.toString()) as { name: string; parents: string[] };
        if (!folder.driveId) return json(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'quota' } });
        const sid = randomBytes(6).toString('hex');
        sessions.set(sid, { parts: [], parent: meta.parents[0]!, name: meta.name });
        res.writeHead(200, { Location: `${urls.upload.replace('/upload', '')}/session/${sid}` });
        return res.end();
      }
      if (url.pathname.startsWith('/session/')) {
        const sid = url.pathname.split('/')[2]!;
        const s = sessions.get(sid);
        if (!s) return json(404, {});
        if (req.method === 'DELETE') {
          sessions.delete(sid);
          return json(204, {});
        }
        const range = req.headers['content-range']!;
        seen.chunkRanges.push(range);
        s.parts.push(data);
        if (range.endsWith('/*')) {
          res.writeHead(308);
          return res.end();
        }
        const id = `file_${sid}`;
        files.set(id, Buffer.concat(s.parts));
        return json(200, { id });
      }
      const m = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const f = files.get(m[1]!);
        if (req.method === 'DELETE') return f ? (files.delete(m[1]!), json(204, {})) : json(404, { error: { errors: [{ reason: 'notFound' }] } });
        if (!f) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(f);
      }
      json(404, {});
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  urls = { token: `${base}/token`, api: `${base}/api`, upload: `${base}/upload` };
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const driver = (config = { folder_id: FOLDER, impersonate_user: '' }) => new GoogleDriveStorageDriver(config, SA, urls);

async function readAll(s: Readable) {
  const out: Buffer[] = [];
  for await (const c of s) out.push(c as Buffer);
  return Buffer.concat(out);
}

describe('GoogleDriveStorageDriver', () => {
  it('signs a valid service-account JWT for the Drive scope and caches the token', async () => {
    const d = driver();
    const checks = await d.precheck();
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(['Service account sign-in', 'Folder access', 'Storage quota']);
    expect(seen.jwtClaims).toMatchObject({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: urls.token });
    const before = seen.tokenRequests;
    await d.precheck();
    expect(seen.tokenRequests).toBe(before);
  });

  it('uploads in 8 MiB resumable chunks into the folder, downloads and deletes', async () => {
    const d = driver();
    const data = randomBytes(8 * 1024 * 1024 + 12345); // two chunks
    seen.chunkRanges = [];
    const id = await d.put('2026/10/abc.bin', Readable.from([data.subarray(0, 1000), data.subarray(1000)]));
    expect(seen.chunkRanges).toEqual([`bytes 0-${8 * 1024 * 1024 - 1}/*`, `bytes ${8 * 1024 * 1024}-${data.length - 1}/${data.length}`]);
    expect([...sessions.values()].at(-1)).toMatchObject({ parent: FOLDER, name: '2026_10_abc.bin' });
    expect((await readAll(await d.get(id))).equals(data)).toBe(true);
    await d.delete(id);
    await d.delete(id); // idempotent
    await expect(d.get(id)).rejects.toThrow(/not shared with|Not found/);
  });

  it('handles an empty file', async () => {
    const d = driver();
    seen.chunkRanges = [];
    const id = await d.put('empty.bin', Readable.from([]));
    expect(seen.chunkRanges).toEqual(['bytes */0']);
    expect((await readAll(await d.get(id))).length).toBe(0);
  });

  it('explains the common setup mistakes', async () => {
    folder = { mimeType: 'application/vnd.google-apps.folder', canAddChildren: true }; // personal My Drive
    const quota = await driver().precheck();
    expect(quota.find((c) => c.name === 'Storage quota')).toMatchObject({ ok: false, detail: expect.stringMatching(/Shared Drive/) });
    await expect(driver().put('x.bin', Readable.from([Buffer.from('x')]))).rejects.toThrow(/Shared Drive/);

    folder = { mimeType: 'application/vnd.google-apps.folder', driveId: '0AShared', canAddChildren: false };
    expect((await driver().precheck()).find((c) => c.name === 'Folder access')).toMatchObject({ ok: false, detail: expect.stringContaining(SA.client_email) });

    const missing = await driver({ folder_id: 'NoSuchFolder123', impersonate_user: '' }).precheck();
    expect(missing.find((c) => c.name === 'Folder access')?.detail).toMatch(/not shared with pay2all@/);

    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrong = new GoogleDriveStorageDriver({ folder_id: FOLDER, impersonate_user: '' }, { ...SA, private_key: otherKey }, urls);
    expect((await wrong.precheck())[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/rejected the key/) });
    folder = { mimeType: 'application/vnd.google-apps.folder', driveId: '0AShared', canAddChildren: true };
  });
});
