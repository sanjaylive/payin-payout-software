import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { ApiKey, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { API_KEY_PERMISSIONS, type apiLogsQuerySchema, type createApiKeySchema, type ipAllowlistEntrySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { keySecretAad } from './api-key-auth.service';

const MAX_ACTIVE_KEYS = 10;
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanum(n: number): string {
  const bytes = randomBytes(n * 2);
  let out = '';
  for (let i = 0; out.length < n && i < bytes.length; i++) if (bytes[i]! < 248) out += ALPHANUM[bytes[i]! % 62];
  return out.length === n ? out : randomAlphanum(n);
}

function presentKey(k: ApiKey) {
  return {
    key_id: k.id,
    organization_id: k.organizationId,
    name: k.name,
    environment: k.environment,
    public_key: k.publicKey,
    secret_hint: `sk_${k.environment.toLowerCase()}_…${k.secretLast4}`,
    permissions: k.permissions,
    status: k.status === 'ACTIVE' && k.expiresAt && k.expiresAt <= new Date() ? 'EXPIRED' : k.status,
    rate_limit_per_minute: k.rateLimitPerMinute,
    expires_at: k.expiresAt,
    last_used_at: k.lastUsedAt,
    last_used_ip: k.lastUsedIp,
    rotated_from_id: k.rotatedFromId,
    created_at: k.createdAt,
    revoked_at: k.revokedAt,
  };
}

/**
 * API key lifecycle (docs/API.md §1). Secrets are generated server-side, shown once, and stored
 * encrypted with the key id as associated data; responses and audit logs only ever carry the
 * last four characters. A key's permissions can never exceed its creator's.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  private assertKeyOwner(actor: Actor) {
    if (actor.kind !== 'user') throw new AppError(ErrorCode.FORBIDDEN);
    if (actor.organizationType !== 'MERCHANT' && actor.organizationType !== 'API_PARTNER') throw new AppError(ErrorCode.FORBIDDEN, 'API keys belong to merchant or API partner accounts');
  }

  private async issue(actor: Actor, input: { name: string; permissions: string[]; rateLimitPerMinute: number; rotatedFromId?: string }) {
    const env = this.config.env.API_ENVIRONMENT;
    const id = newId('apiKey');
    const secret = `sk_${env.toLowerCase()}_${randomBytes(32).toString('base64url')}`;
    const key = await this.prisma.apiKey.create({
      data: {
        id,
        organizationId: actor.organizationId,
        environment: env,
        publicKey: `pk_${env.toLowerCase()}_${randomAlphanum(28)}`,
        secretEncrypted: this.encryptor.encrypt(secret, keySecretAad(id)),
        secretLast4: secret.slice(-4),
        name: input.name,
        permissions: input.permissions,
        rateLimitPerMinute: input.rateLimitPerMinute,
        createdById: actor.userId,
        rotatedFromId: input.rotatedFromId ?? null,
      },
    });
    return { key, secret };
  }

  async create(actor: Actor, input: z.output<typeof createApiKeySchema>) {
    this.assertKeyOwner(actor);
    const grantable = API_KEY_PERMISSIONS.filter((p) => actor.permissions.has(p));
    const requested = input.permissions ?? grantable;
    const excess = requested.filter((p) => !grantable.includes(p));
    if (excess.length) throw new AppError(ErrorCode.FORBIDDEN, `You can't grant permissions you don't hold: ${excess.join(', ')}`);
    if (!requested.length) throw new AppError(ErrorCode.FORBIDDEN, 'You hold none of the API permissions');
    if ((await this.prisma.apiKey.count({ where: { organizationId: actor.organizationId, status: 'ACTIVE' } })) >= MAX_ACTIVE_KEYS) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
    }
    const { key, secret } = await this.issue(actor, { name: input.name, permissions: requested, rateLimitPerMinute: input.rate_limit_per_minute ?? 600 });
    await this.audit.record({ action: 'api_key.created', resourceType: 'api_key', resourceId: key.id, newValue: presentKey(key), metadata: { severity: 'MEDIUM' } });
    return { ...presentKey(key), secret };
  }

  private async requireKey(actor: Actor, id: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const key = await this.prisma.apiKey.findFirst({ where: { id, ...(ids ? { organizationId: { in: ids } } : {}) } });
    if (!key) throw new AppError(ErrorCode.NOT_FOUND, 'API key not found');
    return key;
  }

  async list(actor: Actor) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const keys = await this.prisma.apiKey.findMany({ where: ids ? { organizationId: { in: ids } } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    return keys.map(presentKey);
  }

  /** New key with the same name/permissions; the old one keeps working for `overlapHours`. */
  async rotate(actor: Actor, id: string, overlapHours: number) {
    this.assertKeyOwner(actor);
    const old = await this.requireKey(actor, id);
    if (old.organizationId !== actor.organizationId || old.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only active keys of your account can be rotated');
    const perms = old.permissions.filter((p) => actor.permissions.has(p as never));
    const { key, secret } = await this.issue(actor, { name: old.name, permissions: perms, rateLimitPerMinute: old.rateLimitPerMinute, rotatedFromId: old.id });
    await this.prisma.apiKey.update({
      where: { id: old.id },
      data: overlapHours > 0 ? { expiresAt: new Date(Date.now() + overlapHours * 3600_000) } : { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId },
    });
    await this.audit.record({ action: 'api_key.rotated', resourceType: 'api_key', resourceId: old.id, metadata: { new_key_id: key.id, overlap_hours: overlapHours, severity: 'MEDIUM' } });
    return { ...presentKey(key), secret };
  }

  async revoke(actor: Actor, id: string) {
    this.assertKeyOwner(actor);
    const key = await this.requireKey(actor, id);
    if (key.organizationId !== actor.organizationId) throw new AppError(ErrorCode.NOT_FOUND, 'API key not found');
    const res = await this.prisma.apiKey.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId } });
    if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Key is already revoked');
    await this.audit.record({ action: 'api_key.revoked', resourceType: 'api_key', resourceId: id, metadata: { severity: 'MEDIUM' } });
    return presentKey(await this.prisma.apiKey.findUniqueOrThrow({ where: { id } }));
  }

  // ---- IP allowlist ------------------------------------------------------------------------------

  async listAllowlist(actor: Actor) {
    const rows = await this.prisma.ipAllowlistEntry.findMany({ where: { organizationId: actor.organizationId, environment: this.config.env.API_ENVIRONMENT }, orderBy: { createdAt: 'asc' } });
    return { environment: this.config.env.API_ENVIRONMENT, enforced: rows.length > 0, entries: rows.map((r) => ({ entry_id: r.id, cidr: r.cidr, label: r.label, created_at: r.createdAt })) };
  }

  async addAllowlist(actor: Actor, input: z.output<typeof ipAllowlistEntrySchema>) {
    this.assertKeyOwner(actor);
    const env = this.config.env.API_ENVIRONMENT;
    if ((await this.prisma.ipAllowlistEntry.count({ where: { organizationId: actor.organizationId, environment: env } })) >= 50) throw new AppError(ErrorCode.INVALID_REQUEST, 'At most 50 allowlist entries');
    try {
      await this.prisma.ipAllowlistEntry.create({ data: { id: newId('ipAllowlist'), organizationId: actor.organizationId, environment: env, cidr: input.cidr, label: input.label ?? null, createdById: actor.userId } });
    } catch {
      throw new AppError(ErrorCode.CONFLICT, 'That address is already on the allowlist');
    }
    await this.audit.record({ action: 'api.ip_allowlist.added', resourceType: 'organization', resourceId: actor.organizationId, metadata: { cidr: input.cidr, environment: env, severity: 'MEDIUM' } });
    return this.listAllowlist(actor);
  }

  async removeAllowlist(actor: Actor, entryId: string) {
    this.assertKeyOwner(actor);
    const res = await this.prisma.ipAllowlistEntry.deleteMany({ where: { id: entryId, organizationId: actor.organizationId } });
    if (res.count !== 1) throw new AppError(ErrorCode.NOT_FOUND, 'Entry not found');
    await this.audit.record({ action: 'api.ip_allowlist.removed', resourceType: 'organization', resourceId: actor.organizationId, metadata: { entry_id: entryId, severity: 'MEDIUM' } });
    return this.listAllowlist(actor);
  }

  // ---- Usage & logs --------------------------------------------------------------------------------

  private async orgFilter(actor: Actor, merchantId?: string): Promise<Prisma.ApiRequestLogWhereInput> {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (merchantId && ids && !ids.includes(merchantId)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    return merchantId ? { organizationId: merchantId } : ids ? { organizationId: { in: ids } } : {};
  }

  async logs(actor: Actor, q: z.output<typeof apiLogsQuerySchema>) {
    const cursor = decodeCursor(q.cursor);
    const status = q.status === '2xx' ? { gte: 200, lt: 300 } : q.status === '4xx' ? { gte: 400, lt: 500 } : q.status === '5xx' ? { gte: 500 } : undefined;
    const rows = await this.prisma.apiRequestLog.findMany({
      where: {
        AND: [
          await this.orgFilter(actor, q.merchant_id),
          q.api_key_id ? { apiKeyId: q.api_key_id } : {},
          status ? { statusCode: status } : {},
          q.path ? { path: { startsWith: q.path } } : {},
          cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (r) => ({ id: r.id, organization_id: r.organizationId, api_key_id: r.apiKeyId, partner_id: r.partnerId, method: r.method, path: r.path, status_code: r.statusCode, duration_ms: r.durationMs, error_code: r.errorCode, ip_address: r.ipAddress, request_id: r.requestId, created_at: r.createdAt }));
  }

  async usage(actor: Actor, days: number, merchantId?: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (merchantId && ids && !ids.includes(merchantId)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const orgs = merchantId ? [merchantId] : ids;
    const since = new Date(Date.now() - days * 86_400_000);
    const daily = await this.prisma.$queryRaw<{ day: Date; total: bigint; errors: bigint; p95: number | null }[]>`
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata') AS day, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
        FROM api_request_logs
       WHERE created_at >= ${since} AND (${orgs === null} OR organization_id = ANY(${orgs ?? []}::text[]))
       GROUP BY 1 ORDER BY 1`;
    const top = await this.prisma.$queryRaw<{ method: string; path: string; total: bigint; errors: bigint }[]>`
      SELECT method, regexp_replace(path, '/(pay|pout|rfnd|ben|stl)_[0-9A-Z]{26}', '/\\1_…', 'g') AS path, COUNT(*) AS total, COUNT(*) FILTER (WHERE status_code >= 400) AS errors
        FROM api_request_logs
       WHERE created_at >= ${since} AND (${orgs === null} OR organization_id = ANY(${orgs ?? []}::text[]))
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`;
    const codes = await this.prisma.$queryRaw<{ error_code: string; total: bigint }[]>`
      SELECT error_code, COUNT(*) AS total FROM api_request_logs
       WHERE created_at >= ${since} AND error_code IS NOT NULL AND (${orgs === null} OR organization_id = ANY(${orgs ?? []}::text[]))
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`;
    const total = daily.reduce((s, d) => s + Number(d.total), 0);
    const errors = daily.reduce((s, d) => s + Number(d.errors), 0);
    return {
      days,
      totals: { requests: total, errors, error_rate: total ? errors / total : null },
      daily: daily.map((d) => ({ day: d.day, requests: Number(d.total), errors: Number(d.errors), p95_ms: d.p95 === null ? null : Math.round(d.p95) })),
      top_endpoints: top.map((t) => ({ method: t.method, path: t.path, requests: Number(t.total), errors: Number(t.errors) })),
      top_errors: codes.map((c) => ({ code: c.error_code, count: Number(c.total) })),
    };
  }
}
