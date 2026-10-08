import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateToken, newId, sha256Hex } from '@pay2all/auth';
import type { DbClient, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import { RequestContextStore } from '../../common/context/request-context';
import { ApiConfig } from '../../config/api-config';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import { DashboardIpService } from './dashboard-ip.service';
import { TokenService } from './token.service';

/** Two tabs refreshing at the same moment shouldn't be treated as token theft. */
const REUSE_GRACE_MS = 10_000;

export const revokedSessionKey = (sessionId: string) => `revoked-session:${sessionId}`;

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  restricted: boolean;
}

export type SessionRevokeReason =
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'USER_REVOKED'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'REFRESH_TOKEN_REUSE'
  | 'USER_DISABLED'
  | 'ADMIN_REVOKED';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly dashboardIp: DashboardIpService,
  ) {}

  async create(input: {
    userId: string;
    organizationId: string;
    mfaVerified: boolean;
    restricted: boolean;
  }): Promise<IssuedSession> {
    const ctx = RequestContextStore.get();
    const now = new Date();
    const sessionId = newId('session');
    const refreshToken = generateToken();

    await this.prisma.$transaction(async (tx) => {
      await tx.session.create({
        data: {
          id: sessionId,
          userId: input.userId,
          organizationId: input.organizationId,
          ipAddress: ctx?.ipAddress ?? null,
          userAgent: ctx?.userAgent ?? null,
          mfaVerifiedAt: input.mfaVerified ? now : null,
          mfaEnrollmentRequired: input.restricted,
          expiresAt: new Date(now.getTime() + this.config.env.REFRESH_TOKEN_TTL_SECONDS * 1000),
        },
      });
      await this.insertRefreshToken(tx, sessionId, refreshToken);
    });

    return {
      sessionId,
      refreshToken,
      restricted: input.restricted,
      accessToken: await this.tokens.signAccess({
        sub: input.userId,
        sid: sessionId,
        org: input.organizationId,
        rst: input.restricted,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  /**
   * Rotate a refresh token. The presented token is consumed atomically; a second use of the same
   * token (outside a short grace window) is treated as theft and revokes the whole session.
   */
  async rotate(rawRefreshToken: string): Promise<IssuedSession & { userId: string }> {
    const tokenHash = sha256Hex(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        session: {
          select: {
            id: true,
            userId: true,
            organizationId: true,
            revokedAt: true,
            expiresAt: true,
            lastUsedAt: true,
            mfaEnrollmentRequired: true,
            user: { select: { status: true } },
          },
        },
      },
    });
    if (!record) throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token');

    const { session } = record;
    const now = new Date();

    if (record.usedAt) {
      if (now.getTime() - record.usedAt.getTime() > REUSE_GRACE_MS && !session.revokedAt) {
        await this.revoke(session.id, 'REFRESH_TOKEN_REUSE');
        await this.audit.record({
          action: 'auth.refresh_token.reuse_detected',
          resourceType: 'session',
          resourceId: session.id,
          organizationId: session.organizationId,
          actor: { type: 'USER', id: session.userId },
          metadata: { severity: 'HIGH' },
        });
        this.logger.warn({ sessionId: session.id }, 'Refresh token reuse detected; session revoked');
      }
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
    }

    const idleLimit = new Date(now.getTime() - this.config.env.AUTH_SESSION_IDLE_SECONDS * 1000);
    if (session.revokedAt || session.expiresAt <= now || record.expiresAt <= now || session.lastUsedAt < idleLimit) {
      throw new AppError(ErrorCode.SESSION_EXPIRED);
    }
    if (session.user.status !== 'ACTIVE') {
      await this.revoke(session.id, 'USER_DISABLED');
      throw new AppError(ErrorCode.ACCOUNT_DISABLED);
    }

    // The token stays unused, so the user can continue once back on an allowed network.
    await this.dashboardIp.assertAllowed(session.organizationId);

    const newRefreshToken = generateToken();
    await this.prisma.$transaction(async (tx) => {
      // Atomic consume: only one concurrent caller can flip used_at from NULL.
      const consumed = await tx.refreshToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
      const newId = await this.insertRefreshToken(tx, session.id, newRefreshToken);
      await tx.refreshToken.update({ where: { id: record.id }, data: { replacedById: newId } });
      await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: now } });
    });

    return {
      userId: session.userId,
      sessionId: session.id,
      refreshToken: newRefreshToken,
      restricted: session.mfaEnrollmentRequired,
      accessToken: await this.tokens.signAccess({
        sub: session.userId,
        sid: session.id,
        org: session.organizationId,
        rst: session.mfaEnrollmentRequired,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  /** Issue a fresh access token for an existing session (e.g. after MFA enrollment lifts restriction). */
  async reissueAccessToken(sessionId: string): Promise<{ accessToken: string; expiresIn: number }> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { userId: true, organizationId: true, mfaEnrollmentRequired: true },
    });
    return {
      accessToken: await this.tokens.signAccess({
        sub: session.userId,
        sid: sessionId,
        org: session.organizationId,
        rst: session.mfaEnrollmentRequired,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  async findSessionIdByRefreshToken(rawRefreshToken: string): Promise<string | null> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawRefreshToken) },
      select: { sessionId: true },
    });
    return record?.sessionId ?? null;
  }

  async revoke(sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.markRevoked([sessionId]);
    return result.count === 1;
  }

  /** Revoke every active session of a user, optionally keeping one (the caller's). */
  async revokeAllForUser(userId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    if (active.length === 0) return 0;
    const ids = active.map((s) => s.id);
    await this.prisma.session.updateMany({
      where: { id: { in: ids }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.markRevoked(ids);
    return ids.length;
  }

  listActive(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        organizationId: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        mfaVerifiedAt: true,
      },
    });
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(revokedSessionKey(sessionId))) === 1;
  }

  /** Access tokens are stateless; this Redis mark makes revocation effective immediately. */
  private async markRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const ttl = this.tokens.accessTtlSeconds + 60;
    const pipeline = this.redis.pipeline();
    for (const id of sessionIds) pipeline.set(revokedSessionKey(id), '1', 'EX', ttl);
    await pipeline.exec();
  }

  private async insertRefreshToken(db: DbClient, sessionId: string, raw: string): Promise<string> {
    const id = newId('refreshToken');
    await db.refreshToken.create({
      data: {
        id,
        sessionId,
        tokenHash: sha256Hex(raw),
        expiresAt: new Date(Date.now() + this.config.env.REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    return id;
  }
}
