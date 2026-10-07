import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, StorageBackend } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import {
  type activateStorageSchema,
  type removeStorageBackendSchema,
  type saveStorageBackendSchema,
  STORAGE_KINDS,
  STORAGE_LOCATION_FIELDS,
  STORAGE_SCHEMAS,
  type StorageKindKey,
} from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { StorageService, storageSecretAad } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

const DEFAULT_NAMES: Record<StorageKindKey, string> = { S3: 'Amazon S3', GOOGLE_DRIVE: 'Google Drive', LOCAL: 'Local disk' };

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

function issues(err: z.ZodError, prefix: string) {
  return err.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].join('.'), message: i.message }));
}

/** Does this backend need stored credentials before it can work? */
function needsSecret(kind: StorageKindKey, config: Prisma.JsonValue): boolean {
  if (kind === 'LOCAL') return false;
  if (kind === 'S3') return !(config as { use_instance_role?: boolean }).use_instance_role;
  return true;
}

/** Display-safe summary of credentials: never the secret itself. */
function fingerprintsFor(kind: StorageKindKey, secret: Record<string, string>): Record<string, string> {
  if (kind === 'GOOGLE_DRIVE') return { client_email: secret.client_email ?? '', ...(secret.private_key_id ? { private_key_id: `…${secret.private_key_id.slice(-4)}` } : {}) };
  return Object.fromEntries(Object.entries(secret).map(([k, v]) => [k, `…${String(v).slice(-4)}`]));
}

/**
 * Settings → File Storage (docs/FILE_STORAGE.md): configure Amazon S3, Google Drive and local disk,
 * test them, and choose which one receives new files. Super admin only (`system.settings.manage`);
 * every change is audited with a reason; credentials are encrypted and write-only.
 */
@Injectable()
export class StorageSettingsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  private present(b: StorageBackend | undefined, kind: StorageKindKey, usage: Map<string, { files: number; bytes: bigint }>) {
    const u = b ? usage.get(b.id) : undefined;
    return {
      kind,
      configured: Boolean(b),
      backend_id: b?.id ?? null,
      name: b?.name ?? DEFAULT_NAMES[kind],
      config: b?.config ?? null,
      has_secret: Boolean(b?.secretEncrypted),
      needs_secret: b ? needsSecret(kind, b.config) : kind !== 'LOCAL',
      secret_fingerprints: b?.fingerprints ?? {},
      is_active: b?.isActive ?? false,
      last_test: b?.lastTestedAt ? { at: b.lastTestedAt, ok: b.lastTestOk, error: b.lastTestError } : null,
      usage: { files: u?.files ?? 0, bytes: (u?.bytes ?? 0n).toString() },
      version: b?.version ?? 0,
      updated_at: b?.updatedAt ?? null,
    };
  }

  async overview(actor: Actor) {
    platformOnly(actor);
    const [rows, grouped] = await Promise.all([
      this.prisma.storageBackend.findMany(),
      this.prisma.storageObject.groupBy({ by: ['backendId'], _count: { _all: true }, _sum: { sizeBytes: true } }),
    ]);
    const usage = new Map(grouped.map((g) => [g.backendId, { files: g._count._all, bytes: g._sum.sizeBytes ?? 0n }]));
    const active = rows.find((r) => r.isActive);
    const env = this.config.env;
    const localRoot = this.storage.localRoot();
    return {
      active: (active?.kind ?? 'DEFAULT'),
      server_default: { bucket: env.S3_BUCKET, region: env.S3_REGION, endpoint: env.S3_ENDPOINT || null, server_side_encryption: env.S3_SSE || null },
      local: { available: Boolean(localRoot), root: localRoot },
      backends: STORAGE_KINDS.map((kind) => this.present(rows.find((r) => r.kind === kind), kind, usage)),
    };
  }

  private async byKind(kind: StorageKindKey) {
    return this.prisma.storageBackend.findUnique({ where: { kind } });
  }

  private parse(kind: StorageKindKey, input: z.output<typeof saveStorageBackendSchema>) {
    const config = STORAGE_SCHEMAS[kind].config.safeParse(input.config);
    if (!config.success) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invalid configuration', issues(config.error, 'config'));
    if (kind === 'S3') {
      const c = config.data as z.output<typeof STORAGE_SCHEMAS.S3.config>;
      if (this.config.isProduction && c.endpoint.startsWith('http://')) throw new AppError(ErrorCode.INVALID_REQUEST, 'The endpoint must use https:// in production', [{ path: 'config.endpoint', message: 'Use https://' }]);
    }
    if (kind === 'LOCAL' && !this.storage.localRoot()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Local disk storage is not available: set LOCAL_STORAGE_ROOT on the server first');
    let secret: Record<string, string> | null = null;
    if (input.secret !== undefined && kind !== 'LOCAL') {
      const parsed = STORAGE_SCHEMAS[kind].secret.safeParse(input.secret);
      if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invalid credentials', issues(parsed.error, 'secret'));
      secret = parsed.data;
    }
    return { config: config.data as Prisma.InputJsonObject, secret };
  }

  /** Create or update one kind's settings. The active backend must still pass a test with the new values. */
  async save(actor: Actor, kind: StorageKindKey, input: z.output<typeof saveStorageBackendSchema>) {
    platformOnly(actor);
    const { config, secret } = this.parse(kind, input);
    const before = await this.byKind(kind);

    if (before) {
      const files = await this.prisma.storageObject.count({ where: { backendId: before.id } });
      const old = before.config as Record<string, unknown>;
      const moved = STORAGE_LOCATION_FIELDS[kind].filter((f) => JSON.stringify(old[f] ?? null) !== JSON.stringify((config as Record<string, unknown>)[f] ?? null));
      if (files > 0 && moved.length) {
        throw new AppError(
          ErrorCode.CONFLICT,
          `${files.toLocaleString('en-IN')} files are stored here, so the location can’t change (${moved.join(', ')}). Set up the new location on a different storage type instead.`,
          moved.map((f) => ({ path: `config.${f}`, message: 'Locked while files are stored here' })),
        );
      }
    }

    const id = before?.id ?? newId('storageBackend');
    const data = {
      name: input.name ?? before?.name ?? DEFAULT_NAMES[kind],
      config,
      ...(secret ? { secretEncrypted: this.encryptor.encrypt(JSON.stringify(secret), storageSecretAad(id)), fingerprints: fingerprintsFor(kind, secret) } : {}),
      updatedById: actor.userId,
      // A changed configuration has not been tested yet.
      lastTestedAt: null,
      lastTestOk: null,
      lastTestError: null,
    };

    if (before?.isActive) {
      // Never break uploads: prove the new settings work before they replace the live ones.
      const candidate = { ...before, ...data, version: before.version + 1, secretEncrypted: data.secretEncrypted ?? before.secretEncrypted } as StorageBackend;
      const result = await this.storage.test(candidate);
      if (!result.ok) throw new AppError(ErrorCode.INVALID_REQUEST, 'This storage is in use and the new settings failed the connection test, so nothing was changed', result.checks.filter((c) => !c.ok).map((c) => ({ path: c.name, message: c.detail ?? 'Failed' })));
    }

    await this.prisma.$transaction(async (tx) => {
      if (before) {
        await tx.storageBackend.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      } else {
        await tx.storageBackend.create({ data: { id, kind, ...data } });
      }
      await this.audit.record(
        {
          action: before ? 'storage.backend.updated' : 'storage.backend.created',
          resourceType: 'storage_backend',
          resourceId: id,
          organizationId: null,
          oldValue: before ? { name: before.name, config: before.config } : null,
          newValue: { kind, name: data.name, config, credentials_changed: Boolean(secret) },
          metadata: { reason: input.reason, severity: secret || before?.isActive ? 'HIGH' : 'MEDIUM' },
        },
        tx,
      );
    });
    this.storage.invalidate();
    return this.overview(actor);
  }

  /** Run the connection test against the saved settings and remember the outcome. */
  async test(actor: Actor, kind: StorageKindKey) {
    platformOnly(actor);
    const b = await this.byKind(kind);
    if (!b) throw new AppError(ErrorCode.NOT_FOUND, 'Set this storage up first');
    if (needsSecret(kind, b.config) && !b.secretEncrypted) throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the credentials first');
    const result = await this.storage.test(b);
    const firstError = result.checks.find((c) => !c.ok);
    await this.prisma.storageBackend.update({
      where: { id: b.id },
      data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestError: firstError ? `${firstError.name}: ${firstError.detail ?? 'failed'}`.slice(0, 300) : null },
    });
    await this.audit.record({ action: 'storage.backend.tested', resourceType: 'storage_backend', resourceId: b.id, organizationId: null, metadata: { ok: result.ok } });
    return result;
  }

  /** Choose where new files go. A backend must pass a fresh connection test to be switched on. */
  async activate(actor: Actor, input: z.output<typeof activateStorageSchema>) {
    platformOnly(actor);
    const current = await this.prisma.storageBackend.findFirst({ where: { isActive: true } });
    const from = current?.kind ?? 'DEFAULT';
    if (from === input.kind) return this.overview(actor);

    let target: StorageBackend | null = null;
    if (input.kind !== 'DEFAULT') {
      target = await this.byKind(input.kind);
      if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'Set this storage up first');
      if (needsSecret(input.kind, target.config) && !target.secretEncrypted) throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the credentials first');
      const result = await this.storage.test(target);
      await this.prisma.storageBackend.update({ where: { id: target.id }, data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestError: result.ok ? null : (result.checks.find((c) => !c.ok)?.detail ?? 'failed').slice(0, 300) } });
      if (!result.ok) throw new AppError(ErrorCode.INVALID_REQUEST, 'The connection test failed, so new files still go to the current storage', result.checks.filter((c) => !c.ok).map((c) => ({ path: c.name, message: c.detail ?? 'Failed' })));
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.storageBackend.updateMany({ where: { isActive: true }, data: { isActive: false } });
      if (target) await tx.storageBackend.update({ where: { id: target.id }, data: { isActive: true, updatedById: actor.userId } });
      await this.audit.record(
        { action: 'storage.active_changed', resourceType: 'storage_backend', resourceId: target?.id ?? null, organizationId: null, oldValue: { kind: from }, newValue: { kind: input.kind }, metadata: { reason: input.reason, severity: 'HIGH' } },
        tx,
      );
    });
    this.storage.invalidate();
    return this.overview(actor);
  }

  /** Forget a backend's settings. Only when it is not in use and holds no files. */
  async remove(actor: Actor, kind: StorageKindKey, input: z.output<typeof removeStorageBackendSchema>) {
    platformOnly(actor);
    const b = await this.byKind(kind);
    if (!b) throw new AppError(ErrorCode.NOT_FOUND, 'Not set up');
    if (b.isActive) throw new AppError(ErrorCode.CONFLICT, 'This storage receives new files; choose another one first');
    const files = await this.prisma.storageObject.count({ where: { backendId: b.id } });
    if (files > 0) throw new AppError(ErrorCode.CONFLICT, `${files.toLocaleString('en-IN')} files are stored here; they would become unreadable`);
    await this.prisma.$transaction(async (tx) => {
      await tx.storageBackend.delete({ where: { id: b.id } });
      await this.audit.record({ action: 'storage.backend.removed', resourceType: 'storage_backend', resourceId: b.id, organizationId: null, oldValue: { kind, name: b.name, config: b.config }, metadata: { reason: input.reason, severity: 'MEDIUM' } }, tx);
    });
    this.storage.invalidate();
    return this.overview(actor);
  }
}
