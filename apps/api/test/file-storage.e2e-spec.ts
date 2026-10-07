import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../src/infra/storage.service';
import { pdf } from './fixtures';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let root: string;
let superAdmin: string;
let admin: string;
let compliance: string;
const reason = 'Storage e2e test';

async function readAll(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function reset() {
  await ctx.prisma.storageBackend.updateMany({ data: { isActive: false } });
  await ctx.prisma.storageObject.deleteMany({});
  await ctx.prisma.storageBackend.deleteMany({});
  ctx.app.get(StorageService).invalidate();
}

const s3Config = () => ({
  bucket: process.env.S3_BUCKET ?? 'pay2all-documents',
  region: process.env.S3_REGION ?? 'ap-south-1',
  endpoint: process.env.S3_ENDPOINT ?? '',
  force_path_style: true,
  prefix: 'e2e-storage/',
});
const s3Secret = () => ({ access_key_id: process.env.S3_ACCESS_KEY ?? '', secret_access_key: process.env.S3_SECRET_KEY ?? '' });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p2a-storage-'));
  process.env.LOCAL_STORAGE_ROOT = root;
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  compliance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
  await reset();
});

afterAll(async () => {
  await reset(); // never leave another test file writing to a test backend
  await ctx.app.close();
  delete process.env.LOCAL_STORAGE_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe('file storage settings', () => {
  it('is for super admins only', async () => {
    expect((await ctx.http().get('/v1/storage/backends').set(bearer(admin))).status).toBe(403);
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/storage/backends').set(bearer(m.owner))).status).toBe(403);
    const res = await ctx.http().get('/v1/storage/backends').set(bearer(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ active: 'DEFAULT', local: { available: true, root } });
    expect(res.body.data.backends.map((b: { kind: string; configured: boolean }) => [b.kind, b.configured])).toEqual([
      ['S3', false],
      ['GOOGLE_DRIVE', false],
      ['LOCAL', false],
    ]);
  });

  it('local disk: set up, test, switch on; new files are encrypted on disk and still download byte-for-byte', async () => {
    const save = await ctx.http().put('/v1/storage/backends/LOCAL').set(bearer(superAdmin)).send({ config: { directory: 'kyc' }, reason });
    expect(save.status).toBe(200);
    const test = await ctx.http().post('/v1/storage/backends/LOCAL/test').set(bearer(superAdmin));
    expect(test.body.data.ok).toBe(true);
    expect(test.body.data.checks.map((c: { name: string }) => c.name)).toEqual(['Folder writable', 'Free space', 'Write a test file', 'Read it back', 'Delete it']);
    const on = await ctx.http().post('/v1/storage/active').set(bearer(superAdmin)).send({ kind: 'LOCAL', reason });
    expect(on.body.data.active).toBe('LOCAL');

    // Through the real document API.
    const m = await createApprovedMerchant(ctx);
    const file = pdf('local-disk-secret-content');
    const up = await ctx.http().post(`/v1/merchants/${m.id}/documents`).set(bearer(compliance)).field('type', 'OTHER').attach('file', file, 'x.pdf');
    expect(up.status).toBe(201);
    const doc = await ctx.prisma.merchantDocument.findUniqueOrThrow({ where: { id: up.body.data.id as string } });
    const obj = await ctx.prisma.storageObject.findUniqueOrThrow({ where: { key: doc.storageKey } });
    expect(obj.locator).toMatch(/^kyc\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/);
    expect(obj.sizeBytes).toBe(BigInt(file.length));

    const onDisk = await readFile(join(root, obj.locator));
    expect(onDisk.includes(Buffer.from('local-disk-secret-content'))).toBe(false); // ciphertext only
    expect(onDisk.length).toBe(file.length);

    const res = await ctx.http().get(`/v1/merchants/${m.id}/documents/${doc.id}/content`).set(bearer(compliance)).buffer(true);
    expect(createHash('sha256').update(res.body as Buffer).digest('hex')).toBe(up.body.data.sha256);

    const overview = await ctx.http().get('/v1/storage/backends').set(bearer(superAdmin));
    expect(overview.body.data.backends.find((b: { kind: string }) => b.kind === 'LOCAL').usage.files).toBeGreaterThanOrEqual(1);
  });

  it('locks the location while files are stored there, and refuses to forget a backend in use', async () => {
    const res = await ctx.http().put('/v1/storage/backends/LOCAL').set(bearer(superAdmin)).send({ config: { directory: 'elsewhere' }, reason });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].path).toBe('config.directory');
    expect((await ctx.http().post('/v1/storage/backends/LOCAL/remove').set(bearer(superAdmin)).send({ reason })).status).toBe(409);
  });

  it('a tampered file fails to decrypt instead of being served', async () => {
    const storage = ctx.app.get(StorageService);
    await storage.put('e2e/tamper.txt', Buffer.from('original bytes, authenticated'), 'text/plain', 'x');
    const obj = await ctx.prisma.storageObject.findUniqueOrThrow({ where: { key: 'e2e/tamper.txt' } });
    const p = join(root, obj.locator);
    const bytes = await readFile(p);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(p, bytes);
    await expect(readAll(await storage.getStream('e2e/tamper.txt'))).rejects.toThrow();
    await storage.delete('e2e/tamper.txt');
    expect(await ctx.prisma.storageObject.count({ where: { key: 'e2e/tamper.txt' } })).toBe(0);
  });

  it('S3: wrong secret fails the test with a clear reason and is not switched on; credentials are write-only', async () => {
    const bad = await ctx.http().put('/v1/storage/backends/S3').set(bearer(superAdmin)).send({ config: s3Config(), secret: { ...s3Secret(), secret_access_key: 'definitely-not-the-secret' }, reason });
    expect(bad.status).toBe(200);
    const s3 = bad.body.data.backends.find((b: { kind: string }) => b.kind === 'S3');
    expect(JSON.stringify(s3)).not.toContain('definitely-not-the-secret');
    expect(s3.secret_fingerprints.secret_access_key).toBe('…cret');

    const on = await ctx.http().post('/v1/storage/active').set(bearer(superAdmin)).send({ kind: 'S3', reason });
    expect(on.status).toBe(400);
    expect(on.body.error.message).toMatch(/connection test failed/);
    expect((await ctx.http().get('/v1/storage/backends').set(bearer(superAdmin))).body.data.active).toBe('LOCAL');
  });

  it('S3: switching keeps old files readable from where they were written; new ones land encrypted in the bucket', async () => {
    const storage = ctx.app.get(StorageService);
    await storage.put('e2e/on-local.txt', Buffer.from('written while local was active'), 'text/plain', 'x');

    expect((await ctx.http().put('/v1/storage/backends/S3').set(bearer(superAdmin)).send({ config: s3Config(), secret: s3Secret(), reason })).status).toBe(200);
    const on = await ctx.http().post('/v1/storage/active').set(bearer(superAdmin)).send({ kind: 'S3', reason });
    expect(on.body.data.active).toBe('S3');

    await storage.put('e2e/on-s3.txt', Buffer.from('written while s3 was active'), 'text/plain', 'x');
    const obj = await ctx.prisma.storageObject.findUniqueOrThrow({ where: { key: 'e2e/on-s3.txt' }, include: { backend: true } });
    expect(obj.backend.kind).toBe('S3');
    expect(obj.locator.startsWith('e2e-storage/')).toBe(true);
    const raw = await new S3Client({ region: s3Config().region, endpoint: s3Config().endpoint, forcePathStyle: true, credentials: { accessKeyId: s3Secret().access_key_id, secretAccessKey: s3Secret().secret_access_key } }).send(
      new GetObjectCommand({ Bucket: s3Config().bucket, Key: obj.locator }),
    );
    expect(Buffer.from(await raw.Body!.transformToByteArray()).toString()).not.toContain('written while s3');

    expect((await readAll(await storage.getStream('e2e/on-local.txt'))).toString()).toBe('written while local was active');
    expect((await readAll(await storage.getStream('e2e/on-s3.txt'))).toString()).toBe('written while s3 was active');

    // Back to the server default: new files go to the environment bucket (no storage_objects row), old ones stay readable.
    expect((await ctx.http().post('/v1/storage/active').set(bearer(superAdmin)).send({ kind: 'DEFAULT', reason })).body.data.active).toBe('DEFAULT');
    await storage.put('e2e/on-default.txt', Buffer.from('default bucket'), 'text/plain', 'x');
    expect(await ctx.prisma.storageObject.count({ where: { key: 'e2e/on-default.txt' } })).toBe(0);
    expect((await readAll(await storage.getStream('e2e/on-default.txt'))).toString()).toBe('default bucket');
    expect((await readAll(await storage.getStream('e2e/on-s3.txt'))).toString()).toBe('written while s3 was active');
    await Promise.all(['e2e/on-local.txt', 'e2e/on-s3.txt', 'e2e/on-default.txt'].map((k) => storage.delete(k)));

    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'storage.active_changed' }, orderBy: { createdAt: 'asc' } });
    expect(audits.at(-1)).toMatchObject({ oldValue: { kind: 'S3' }, newValue: { kind: 'DEFAULT' } });
  });

  it('rejects unsafe or invalid settings', async () => {
    const bad = await ctx.http().put('/v1/storage/backends/LOCAL').set(bearer(superAdmin)).send({ config: { directory: '../../etc' }, reason });
    expect(bad.status).toBe(400);
    const drive = await ctx.http().put('/v1/storage/backends/GOOGLE_DRIVE').set(bearer(superAdmin)).send({ config: { folder_id: '1AbCdEfGhIjKlMnOp' }, secret: { type: 'authorized_user', client_email: 'x@y.z' }, reason });
    expect(drive.status).toBe(400);
    expect((await ctx.http().put('/v1/storage/backends/FTP').set(bearer(superAdmin)).send({ config: {}, reason })).status).toBe(400);
  });
});
