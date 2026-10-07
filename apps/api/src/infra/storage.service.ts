import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { PassThrough, pipeline, Readable, Transform } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FieldEncryptor } from '@pay2all/auth';
import type { PrismaClient, StorageBackend } from '@pay2all/database';
import { STORAGE_SCHEMAS, type StorageKindKey } from '@pay2all/validation';
import { ApiConfig } from '../config/api-config';
import { type StorageCheck, type StorageDriver, StorageDriverError, timed } from './storage/driver';
import { GoogleDriveStorageDriver } from './storage/google-drive-driver';
import { LocalStorageDriver } from './storage/local-driver';
import { S3StorageDriver } from './storage/s3-driver';
import { PRISMA } from './tokens';

export const storageSecretAad = (id: string) => `storage:${id}`;
const objectKeyAad = (key: string) => `storage-object:${key}`;
/** How long a node keeps using its view of the active backend after an admin switches it. */
const ACTIVE_TTL_MS = 10_000;

/**
 * Object storage for KYC documents, reconciliation files and report exports (docs/FILE_STORAGE.md).
 * The database holds metadata and the object key; callers only ever use keys.
 *
 * - New files go to the backend an administrator made active (S3, Google Drive or local disk), each
 *   encrypted here with its own AES-256-GCM data key (wrapped by the platform key) — the backend only
 *   ever holds ciphertext. `storage_objects` records where each one went and how to decrypt it.
 * - With no backend active, and for every file written before backends existed, the server's
 *   environment S3 bucket is used, as before.
 * - Switching backends never moves files: each is read back from wherever it was written.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  readonly bucket: string;
  private active: { at: number; backend: StorageBackend | null } | null = null;
  private readonly drivers = new Map<string, StorageDriver>();

  constructor(
    private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
  ) {
    const env = config.env;
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } } : {}),
    });
  }

  /** Development convenience: create the bucket if missing. Production buckets are provisioned by IaC. */
  async onModuleInit(): Promise<void> {
    if (this.config.isProduction) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log({ bucket: this.bucket }, 'Created storage bucket');
      } catch (err) {
        this.logger.warn({ err, bucket: this.bucket }, 'Storage bucket unavailable; document uploads will fail');
      }
    }
  }

  // ---- Public API (keys only) ----------------------------------------------------------------------

  async put(key: string, body: Buffer, contentType: string, sha256Hex: string): Promise<void> {
    const backend = await this.activeBackend();
    if (backend) return this.writeVia(backend, key, Readable.from([body]), contentType, sha256Hex);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        Metadata: { sha256: sha256Hex },
        ...(this.config.env.S3_SSE ? { ServerSideEncryption: this.config.env.S3_SSE as 'AES256' } : {}),
      }),
    );
  }

  /** Streaming upload with bounded memory, for large generated files. */
  async putStream(key: string, body: Readable, contentType: string): Promise<void> {
    const backend = await this.activeBackend();
    if (backend) return this.writeVia(backend, key, body, contentType, null);
    await new Upload({
      client: this.client,
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.config.env.S3_SSE ? { ServerSideEncryption: this.config.env.S3_SSE as 'AES256' } : {}),
      },
    }).done();
  }

  async delete(key: string): Promise<void> {
    const row = await this.prisma.storageObject.findUnique({ where: { key }, include: { backend: true } });
    if (!row) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    await this.driverFor(row.backend).delete(row.locator);
    await this.prisma.storageObject.deleteMany({ where: { key, locator: row.locator } });
  }

  async getStream(key: string): Promise<Readable> {
    const row = await this.prisma.storageObject.findUnique({ where: { key }, include: { backend: true } });
    if (!row) {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(res.Body instanceof Readable)) throw new Error('Unexpected object body type');
      return res.Body;
    }
    const source = await this.driverFor(row.backend).get(row.locator);
    const dataKey = Buffer.from(this.encryptor.decrypt(row.wrappedKey, objectKeyAad(key)), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
    // A tampered or truncated file fails authentication at the end and errors the stream.
    return pipeline(source, decipher, (err) => {
      if (err) this.logger.error({ err: err.name, key }, 'Stored file failed to decrypt or read');
    });
  }

  // ---- Backends ------------------------------------------------------------------------------------

  /** Called after an administrator changes backends, so this node switches immediately. */
  invalidate(): void {
    this.active = null;
    this.drivers.clear();
  }

  async activeBackend(): Promise<StorageBackend | null> {
    if (this.active && Date.now() - this.active.at < ACTIVE_TTL_MS) return this.active.backend;
    const backend = await this.prisma.storageBackend.findFirst({ where: { isActive: true } });
    this.active = { at: Date.now(), backend };
    return backend;
  }

  /** The absolute local root, or null when local disk storage is not available on this server. */
  localRoot(): string | null {
    const root = this.config.env.LOCAL_STORAGE_ROOT;
    if (root) return isAbsolute(root) ? resolve(root) : null;
    return this.config.isProduction ? null : resolve(process.cwd(), '.storage');
  }

  /** Build a driver for a backend row (cached per id + version, so edits take effect at once). */
  driverFor(b: StorageBackend): StorageDriver {
    const cacheKey = `${b.id}:${b.version}`;
    const cached = this.drivers.get(cacheKey);
    if (cached) return cached;
    const driver = this.buildDriver(b.kind, b.config, b.secretEncrypted ? (JSON.parse(this.encryptor.decrypt(b.secretEncrypted, storageSecretAad(b.id))) as unknown) : null);
    this.drivers.set(cacheKey, driver);
    return driver;
  }

  buildDriver(kind: StorageKindKey, rawConfig: unknown, rawSecret: unknown): StorageDriver {
    switch (kind) {
      case 'S3':
        return new S3StorageDriver(STORAGE_SCHEMAS.S3.config.parse(rawConfig), rawSecret ? STORAGE_SCHEMAS.S3.secret.parse(rawSecret) : null);
      case 'GOOGLE_DRIVE':
        return new GoogleDriveStorageDriver(STORAGE_SCHEMAS.GOOGLE_DRIVE.config.parse(rawConfig), rawSecret ? STORAGE_SCHEMAS.GOOGLE_DRIVE.secret.parse(rawSecret) : null);
      case 'LOCAL': {
        const root = this.localRoot();
        if (!root) throw new StorageDriverError('Local disk storage is not available: set LOCAL_STORAGE_ROOT on the server');
        return new LocalStorageDriver(root, STORAGE_SCHEMAS.LOCAL.config.parse(rawConfig));
      }
      default:
        throw new StorageDriverError('Unknown storage kind');
    }
  }

  /**
   * Connection test: the backend's own checks, then a real encrypted write → read → compare → delete.
   * Nothing is recorded in storage_objects.
   */
  async test(b: StorageBackend): Promise<{ ok: boolean; checks: StorageCheck[] }> {
    let driver: StorageDriver;
    try {
      driver = this.driverFor(b);
    } catch (err) {
      return { ok: false, checks: [{ name: 'Configuration', ok: false, detail: err instanceof StorageDriverError ? err.message : 'Invalid configuration' }] };
    }
    const checks = await driver.precheck().catch((err: unknown): StorageCheck[] => [{ name: 'Connection', ok: false, detail: message(err) }]);
    if (checks.some((c) => !c.ok)) return { ok: false, checks };

    const probe = randomBytes(64 * 1024);
    let locator: string | null = null;
    try {
      const w = await timed(() => driver.put(`_pay2all-check/${randomUUID()}.bin`, Readable.from([probe])));
      locator = w.value;
      checks.push({ name: 'Write a test file', ok: true, ms: w.ms });
      const r = await timed(async () => {
        const chunks: Buffer[] = [];
        for await (const c of await driver.get(w.value)) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
      });
      const same = r.value.equals(probe);
      checks.push({ name: 'Read it back', ok: same, detail: same ? undefined : 'The file read back differs from what was written', ms: r.ms });
    } catch (err) {
      if (!(err instanceof StorageDriverError)) this.logger.warn({ err, backend: b.id }, 'Storage test failed unexpectedly');
      checks.push({ name: locator ? 'Read it back' : 'Write a test file', ok: false, detail: message(err) });
    }
    if (locator) {
      const loc = locator;
      try {
        const d = await timed(() => driver.delete(loc));
        checks.push({ name: 'Delete it', ok: true, ms: d.ms });
      } catch (err) {
        checks.push({ name: 'Delete it', ok: false, detail: message(err) });
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  private async writeVia(backend: StorageBackend, key: string, body: Readable, contentType: string, sha256: string | null): Promise<void> {
    const driver = this.driverFor(backend);
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    let size = 0n;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += BigInt(chunk.length);
        cb(null, chunk);
      },
    });
    const sealed = new PassThrough();
    pipeline(body, counter, cipher, sealed, () => undefined); // errors surface through `sealed` to the driver
    const now = new Date();
    const name = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.bin`;
    let locator: string;
    try {
      locator = await driver.put(name, sealed);
    } catch (err) {
      sealed.destroy();
      body.destroy();
      throw err;
    }
    const data = {
      backendId: backend.id,
      locator,
      sizeBytes: size,
      contentType: contentType.slice(0, 120),
      sha256,
      wrappedKey: this.encryptor.encrypt(dataKey.toString('base64'), objectKeyAad(key)),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
    try {
      const previous = await this.prisma.$transaction(async (tx) => {
        const prev = await tx.storageObject.findUnique({ where: { key }, include: { backend: true } });
        await tx.storageObject.upsert({ where: { key }, create: { key, ...data }, update: { ...data, createdAt: now } });
        return prev;
      });
      // Overwrote a key: remove the old copy (best effort — it is unreachable either way).
      if (previous) await this.driverFor(previous.backend).delete(previous.locator).catch((err: unknown) => this.logger.warn({ err: message(err), key }, 'Could not delete replaced file'));
    } catch (err) {
      await driver.delete(locator).catch(() => undefined);
      throw err;
    }
  }
}

function message(err: unknown): string {
  return err instanceof StorageDriverError ? err.message : err instanceof Error && err.name === 'ZodError' ? 'Invalid configuration' : 'Unexpected storage error';
}
