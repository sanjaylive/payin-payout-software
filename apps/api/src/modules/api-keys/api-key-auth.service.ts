import { BlockList, isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_SIGNATURE_TOLERANCE_SECONDS, FieldEncryptor, newId, NONCE_RE, type PermissionKey, verifyApiSignature } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { PRISMA, REDIS } from '../../infra/tokens';
import type { Actor } from '../auth/actor';

const AUTH_FAILURES = { name: 'api-auth-fail', limit: 60, windowSeconds: 60 };

export const keySecretAad = (keyId: string) => `api-key:${keyId}`;
export const API_KEY_HEADERS = { key: 'x-pay2all-key', timestamp: 'x-pay2all-timestamp', nonce: 'x-pay2all-nonce', signature: 'x-pay2all-signature', merchant: 'x-pay2all-merchant' } as const;

/**
 * Authenticates server-to-server requests (docs/API.md §2):
 * key lookup → environment → HMAC over `${t}.${nonce}.${METHOD}.${path}.${sha256(body)}` (constant
 * time, ±5 min) → replay guard (each nonce usable once per key) → IP allowlist → per-key rate limit →
 * partner "on behalf of merchant" resolution. Failures are uniform 401s that don't reveal which check
 * failed (except IP/rate-limit, which the caller must be able to act on).
 */
@Injectable()
export class ApiKeyAuthService {
  private readonly logger = new Logger(ApiKeyAuthService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly encryptor: FieldEncryptor,
    private readonly rateLimit: RateLimitService,
    private readonly config: ApiConfig,
  ) {}

  static isApiKeyRequest(req: Request): boolean {
    return typeof req.headers[API_KEY_HEADERS.key] === 'string';
  }

  async authenticate(req: Request & { rawBody?: Buffer }, res: Response): Promise<Actor> {
    const ip = RequestContextStore.get()?.ipAddress ?? req.ip ?? null;
    const header = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n]) : '');
    const publicKey = header(API_KEY_HEADERS.key);
    const deny = async (why: string): Promise<never> => {
      await this.rateLimit.consume(AUTH_FAILURES, ip ?? 'unknown');
      this.logger.warn({ reason: why, key: publicKey.slice(0, 16), ip }, 'API key authentication failed');
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API credentials or signature');
    };
    // An address that keeps failing authentication is cut off before any key lookup.
    if ((await this.rateLimit.peek(AUTH_FAILURES, ip ?? 'unknown')) >= AUTH_FAILURES.limit) throw new AppError(ErrorCode.RATE_LIMITED);

    const key = /^pk_(test|live)_[A-Za-z0-9]{24,40}$/.test(publicKey) ? await this.prisma.apiKey.findUnique({ where: { publicKey } }) : null;
    if (!key) return deny('unknown key');
    this.logRequest(req, res, key.organizationId, key.id, Date.now(), ip);
    if (key.status !== 'ACTIVE' || (key.expiresAt && key.expiresAt <= new Date())) return deny('revoked or expired');
    if (key.environment !== this.config.env.API_ENVIRONMENT) throw new AppError(ErrorCode.UNAUTHORIZED, `This is a ${key.environment} key; this endpoint accepts ${this.config.env.API_ENVIRONMENT} keys`);

    const ts = Number(header(API_KEY_HEADERS.timestamp));
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > API_SIGNATURE_TOLERANCE_SECONDS) return deny('timestamp outside tolerance');
    const nonce = header(API_KEY_HEADERS.nonce);
    if (!NONCE_RE.test(nonce)) return deny('missing or malformed nonce');
    const signature = header(API_KEY_HEADERS.signature);
    const secret = this.encryptor.decrypt(key.secretEncrypted, keySecretAad(key.id));
    if (!signature || !verifyApiSignature(secret, signature, ts, nonce, req.method, req.originalUrl, req.rawBody)) return deny('bad signature');
    // Each signed nonce is usable once per key: a captured request can't be replayed within the window.
    if ((await this.redis.set(`api-nonce:${key.id}:${nonce}`, '1', 'EX', API_SIGNATURE_TOLERANCE_SECONDS * 2, 'NX')) !== 'OK') return deny('replayed nonce');

    const org = await this.prisma.organization.findUnique({ where: { id: key.organizationId }, select: { id: true, type: true, status: true, parentId: true } });
    if (!org || org.status !== 'ACTIVE') return deny('organization inactive');
    await this.assertIpAllowed(org.id, key.environment, ip);

    const limit = await this.rateLimit.consume({ name: 'api-key', limit: key.rateLimitPerMinute, windowSeconds: 60 }, key.id);
    res.setHeader('RateLimit-Limit', String(key.rateLimitPerMinute));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, key.rateLimitPerMinute - limit.count)));
    res.setHeader('RateLimit-Reset', String(60 - (Math.floor(Date.now() / 1000) % 60)));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new AppError(ErrorCode.RATE_LIMITED);
    }
    void this.touch(key.id, ip);

    const permissions = new Set(key.permissions as PermissionKey[]);
    const base: Actor = { kind: 'api_key', userId: key.id, apiKeyId: key.id, sessionId: 'api-key', organizationId: org.id, organizationType: org.type, organizationParentId: org.parentId, roleKeys: [], permissions, restricted: false };

    // An API partner's key acts for one of ITS merchants when the request names it.
    const onBehalf = header(API_KEY_HEADERS.merchant);
    if (onBehalf) {
      if (org.type !== 'API_PARTNER') throw new AppError(ErrorCode.FORBIDDEN, `${API_KEY_HEADERS.merchant} is only for API partner keys`);
      const merchant = await this.prisma.organization.findFirst({ where: { id: onBehalf, type: 'MERCHANT', parentId: org.id }, select: { id: true, status: true, parentId: true } });
      if (!merchant) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
      if (merchant.status !== 'ACTIVE') throw new AppError(ErrorCode.MERCHANT_INACTIVE);
      return { ...base, organizationId: merchant.id, organizationType: 'MERCHANT', organizationParentId: merchant.parentId, partnerOrganizationId: org.id };
    }
    return base;
  }

  private async assertIpAllowed(organizationId: string, environment: 'TEST' | 'LIVE', ip: string | null) {
    const entries = await this.prisma.ipAllowlistEntry.findMany({ where: { organizationId, environment }, select: { cidr: true } });
    if (!entries.length) return;
    const list = new BlockList();
    for (const e of entries) {
      const [addr, bits] = e.cidr.split('/');
      const family = isIP(addr!) === 6 ? 'ipv6' : 'ipv4';
      if (bits) list.addSubnet(addr!, Number(bits), family);
      else list.addAddress(addr!, family);
    }
    const normalized = ip?.replace(/^::ffff:/, '') ?? '';
    const family = isIP(normalized) === 6 ? 'ipv6' : 'ipv4';
    if (!normalized || !list.check(normalized, family)) {
      this.logger.warn({ organizationId, ip }, 'API request from an address outside the allowlist');
      throw new AppError(ErrorCode.IP_NOT_ALLOWED, `Requests from ${normalized || 'this address'} are not on your IP allowlist`);
    }
  }

  /** last_used_at at most once a minute per key (avoids a hot row). */
  private async touch(keyId: string, ip: string | null) {
    if ((await this.redis.set(`api-key-touch:${keyId}`, '1', 'EX', 60, 'NX')) !== 'OK') return;
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(), lastUsedIp: ip } }).catch(() => undefined);
  }

  /** Usage log written when the response finishes (status known); best effort, never blocks. */
  private logRequest(req: Request, res: Response, organizationId: string, apiKeyId: string, started: number, ip: string | null) {
    res.once('finish', () => {
      const actor = (req as Request & { actor?: Actor }).actor;
      void this.prisma.apiRequestLog
        .create({
          data: {
            id: newId('apiRequest'),
            organizationId: actor?.organizationId ?? organizationId,
            apiKeyId,
            partnerId: actor?.partnerOrganizationId ?? null,
            method: req.method.slice(0, 8),
            path: req.path.slice(0, 200),
            statusCode: res.statusCode,
            durationMs: Date.now() - started,
            errorCode: (res.locals.errorCode as string | undefined) ?? null,
            ipAddress: ip,
            requestId: RequestContextStore.get()?.requestId ?? null,
          },
        })
        .catch((err: unknown) => this.logger.warn({ err }, 'Could not write API request log'));
    });
  }
}
