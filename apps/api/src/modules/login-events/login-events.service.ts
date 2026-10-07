import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { LoginEvent, LoginOutcome, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { listLoginEventsQuerySchema, loginEventsExportSchema, loginLocationSchema } from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { csvCell } from '../reports/report-writer';
import { summariseUserAgent } from './user-agent';

const IST_OFFSET = '+05:30';
const CSV_ROW_CAP = 10_000;
const FAILURES: LoginOutcome[] = ['MFA_FAILED', 'BAD_PASSWORD', 'LOCKED', 'DISABLED', 'NOT_ACTIVATED', 'NO_ACTIVE_ORGANIZATION', 'UNKNOWN_USER'];

export interface LoginAttempt {
  userId: string | null;
  organizationId: string | null;
  identifierMasked: string;
  outcome: LoginOutcome;
  mfaUsed?: boolean;
  sessionId?: string | null;
  location?: z.output<typeof loginLocationSchema>;
}

type Row = LoginEvent & { userName: string | null; userEmail: string | null };

export function presentLoginEvent(e: Row) {
  return {
    event_id: e.id,
    created_at: e.createdAt,
    organization_id: e.organizationId,
    user_id: e.userId,
    user_name: e.userName,
    identifier: e.identifierMasked,
    outcome: e.outcome,
    success: e.outcome === 'SUCCESS',
    mfa_used: e.mfaUsed,
    ip_address: e.ipAddress,
    browser: e.browser,
    os: e.os,
    device_type: e.deviceType,
    location: e.latitude !== null && e.longitude !== null ? { latitude: Number(e.latitude), longitude: Number(e.longitude), accuracy_m: e.locationAccuracyM } : null,
  };
}

/**
 * Sign-in history (docs/SECURITY.md §1.6): every attempt with outcome, IP, device and — when the
 * user allowed it in the browser — location. Append-only. Merchants see their own organization;
 * resellers / partners their merchants; platform staff everyone.
 */
@Injectable()
export class LoginEventsService {
  private readonly logger = new Logger(LoginEventsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Never throws: a logging failure must not block (or reveal anything about) a sign-in. */
  async record(a: LoginAttempt): Promise<void> {
    try {
      const ctx = RequestContextStore.get();
      const device = summariseUserAgent(ctx?.userAgent);
      let organizationId = a.organizationId;
      if (!organizationId && a.userId) {
        organizationId = (await this.prisma.userRole.findFirst({ where: { userId: a.userId }, orderBy: { createdAt: 'asc' }, select: { organizationId: true } }))?.organizationId ?? null;
      }
      await this.prisma.loginEvent.create({
        data: {
          id: newId('loginEvent'),
          userId: a.userId,
          organizationId,
          identifierMasked: a.identifierMasked.slice(0, 254),
          outcome: a.outcome,
          mfaUsed: a.mfaUsed ?? false,
          sessionId: a.sessionId ?? null,
          ipAddress: ctx?.ipAddress?.slice(0, 64) ?? null,
          userAgent: ctx?.userAgent?.slice(0, 512) ?? null,
          browser: device.browser,
          os: device.os,
          deviceType: device.deviceType,
          ...(a.location
            ? { latitude: a.location.latitude.toFixed(6), longitude: a.location.longitude.toFixed(6), locationAccuracyM: a.location.accuracy === undefined ? null : Math.round(a.location.accuracy) }
            : {}),
          requestId: ctx?.requestId ?? null,
        },
      });
    } catch (err) {
      this.logger.error({ err, outcome: a.outcome }, 'Could not record login event');
    }
  }

  /** Which organizations' sign-ins the actor may see, narrowed to one when asked. */
  private async orgFilter(actor: Actor, organizationId?: string): Promise<Prisma.LoginEventWhereInput> {
    if (organizationId) {
      await this.scope.requireOrganization(actor, organizationId);
      return { organizationId };
    }
    const ids = await this.scope.accessibleOrganizationIds(actor);
    return ids ? { organizationId: { in: ids } } : {};
  }

  private async where(actor: Actor, q: { organization_id?: string; user_id?: string; outcome?: LoginOutcome; result?: 'success' | 'failure'; from?: string; to?: string }) {
    return {
      AND: [
        await this.orgFilter(actor, q.organization_id),
        q.user_id ? { userId: q.user_id } : {},
        q.outcome ? { outcome: q.outcome } : {},
        q.result === 'success' ? { outcome: 'SUCCESS' as const } : q.result === 'failure' ? { outcome: { in: FAILURES } } : {},
        q.from ? { createdAt: { gte: new Date(`${q.from}T00:00:00${IST_OFFSET}`) } } : {},
        q.to ? { createdAt: { lt: new Date(new Date(`${q.to}T00:00:00${IST_OFFSET}`).getTime() + 86_400_000) } } : {},
      ],
    } satisfies Prisma.LoginEventWhereInput;
  }

  private async withUsers(rows: LoginEvent[]): Promise<Row[]> {
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => Boolean(x)))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, userName: r.userId ? (byId.get(r.userId)?.name ?? null) : null, userEmail: r.userId ? (byId.get(r.userId)?.email ?? null) : null }));
  }

  async list(actor: Actor, q: z.output<typeof listLoginEventsQuerySchema>) {
    const rows = await this.prisma.loginEvent.findMany({
      where: { AND: [await this.where(actor, q), keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = toPage(await this.withUsers(rows), q.limit, presentLoginEvent);
    return page;
  }

  /** Summary cards: attempts, failures, distinct IPs and devices over the range. */
  async summary(actor: Actor, q: z.output<typeof listLoginEventsQuerySchema>) {
    const where = await this.where(actor, q);
    const [total, failures, ips, last] = await Promise.all([
      this.prisma.loginEvent.count({ where }),
      this.prisma.loginEvent.count({ where: { AND: [where, { outcome: { in: FAILURES } }] } }),
      this.prisma.loginEvent.findMany({ where: { AND: [where, { ipAddress: { not: null } }] }, distinct: ['ipAddress'], select: { ipAddress: true }, take: 1000 }),
      this.prisma.loginEvent.findFirst({ where: { AND: [where, { outcome: 'SUCCESS' }] }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    return { attempts: total, failures, distinct_ips: ips.length, last_success_at: last?.createdAt ?? null };
  }

  /** Immediate CSV download (bounded); larger ranges go through the async export. */
  async exportCsv(actor: Actor, q: z.output<typeof loginEventsExportSchema>, res: Response): Promise<void> {
    const where = await this.where(actor, { organization_id: q.organization_id, from: q.from, to: q.to });
    const rows = await this.prisma.loginEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CSV_ROW_CAP + 1 });
    if (rows.length > CSV_ROW_CAP) throw new AppError(ErrorCode.INVALID_REQUEST, `More than ${CSV_ROW_CAP.toLocaleString('en-IN')} sign-ins in this range — use “Email me” for large exports`);
    const lines = [
      ['time', 'user', 'email_or_mobile', 'outcome', 'mfa', 'ip_address', 'browser', 'os', 'device', 'latitude', 'longitude', 'accuracy_m', 'organization_id', 'event_id'],
      ...(await this.withUsers(rows)).map((r) => [
        r.createdAt,
        r.userName,
        r.identifierMasked,
        r.outcome,
        r.mfaUsed ? 'yes' : 'no',
        r.ipAddress,
        r.browser,
        r.os,
        r.deviceType,
        r.latitude?.toString() ?? null,
        r.longitude?.toString() ?? null,
        r.locationAccuracyM,
        r.organizationId,
        r.id,
      ]),
    ];
    await this.audit.record({ action: 'login_events.exported', resourceType: 'organization', resourceId: q.organization_id ?? null, metadata: { from: q.from, to: q.to, rows: rows.length, delivery: 'download' } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pay2all-logins-${q.from}-to-${q.to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`\uFEFF${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`);
  }
}
