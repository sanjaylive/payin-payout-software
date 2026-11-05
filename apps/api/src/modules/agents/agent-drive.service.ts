import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldEncryptor, generateToken } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { PRISMA, REDIS } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { csvCell, type CellValue } from '../reports/report-writer';
import { agentOnly, istDateString, istMonthStart } from './agent-common';
import { AgentPlansService } from './agent-plans.service';
import { AgentReceiptsService } from './agent-receipts.service';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** drive.file: the app sees only files it created — never the rest of the agent's Drive. */
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';
const STATE_TTL_SECONDS = 600;
const tokenAad = (agentId: string) => `agent-drive:${agentId}`;
const stateKey = (s: string) => `agent-drive-state:${s}`;
const BACKUP_LIMIT = { name: 'agent-drive-backup', limit: 6, windowSeconds: 3600 } as const;
const AUTO_EVERY_MS = 20 * 3600_000;

class DriveError extends Error {}

async function rowsToCsv(rows: AsyncIterable<CellValue[]>): Promise<Buffer> {
  const parts: string[] = ['﻿'];
  for await (const r of rows) parts.push(`${r.map(csvCell).join(',')}\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

/**
 * Agents' own Google Drive backups (docs/AGENTS.md §7): OAuth (authorization code, offline access)
 * into an encrypted refresh token, then CSV copies of transactions and customers into one folder.
 */
@Injectable()
export class AgentDriveService {
  private readonly logger = new Logger(AgentDriveService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ApiConfig,
    private readonly encryptor: FieldEncryptor,
    private readonly plans: AgentPlansService,
    private readonly receipts: AgentReceiptsService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  private get configured() {
    return Boolean(this.config.env.GOOGLE_OAUTH_CLIENT_ID && this.config.env.GOOGLE_OAUTH_CLIENT_SECRET);
  }

  private redirectUri() {
    return `${this.config.env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/public/agent-drive/callback`;
  }

  webReturn(result: 'connected' | 'error') {
    return `${this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '')}/agent/backup?drive=${result}`;
  }

  async status(actor: Actor) {
    const agentId = agentOnly(actor);
    const [c, eff] = await Promise.all([this.prisma.agentDriveConnection.findUnique({ where: { agentId } }), this.plans.effective(agentId)]);
    return {
      available: this.configured,
      included_in_plan: eff.plan.driveBackup,
      connected: Boolean(c),
      google_email: c?.googleEmail ?? null,
      status: c?.status ?? null,
      auto_backup: c?.autoBackup ?? false,
      last_backup_at: c?.lastBackupAt ?? null,
      last_error: c?.lastError ?? null,
      folder_url: c?.folderId ? `https://drive.google.com/drive/folders/${c.folderId}` : null,
    };
  }

  async connect(actor: Actor) {
    const agentId = agentOnly(actor);
    if (!this.configured) throw new AppError(ErrorCode.INVALID_REQUEST, 'Google Drive backup is not set up on this platform yet');
    await this.plans.assertFeature(agentId, 'driveBackup', 'Google Drive backup');
    const state = generateToken(24);
    await this.redis.set(stateKey(state), JSON.stringify({ agentId, userId: actor.userId }), 'EX', STATE_TTL_SECONDS);
    const params = new URLSearchParams({
      client_id: this.config.env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return { url: `${AUTH_URL}?${params.toString()}` };
  }

  /** Google redirects the browser here. Returns where to send the browser next. */
  async callback(code: string | undefined, state: string | undefined, error: string | undefined): Promise<string> {
    if (!state) return this.webReturn('error');
    const raw = await this.redis.getdel(stateKey(state));
    if (!raw || error || !code) return this.webReturn('error');
    const { agentId, userId } = JSON.parse(raw) as { agentId: string; userId: string };
    try {
      const tokens = await this.post<{ refresh_token?: string; id_token?: string; access_token: string }>(TOKEN_URL, {
        code,
        client_id: this.config.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: this.config.env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
      });
      if (!tokens.refresh_token) throw new DriveError('Google did not return a refresh token');
      // The id_token comes straight from Google's token endpoint over TLS; only the email is read.
      let email: string | null = null;
      if (tokens.id_token) {
        try {
          email = (JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string }).email ?? null;
        } catch {
          email = null;
        }
      }
      const refreshTokenEnc = this.encryptor.encrypt(tokens.refresh_token, tokenAad(agentId));
      await this.prisma.$transaction(async (tx) => {
        await tx.agentDriveConnection.upsert({
          where: { agentId },
          create: { agentId, googleEmail: email, refreshTokenEnc, connectedById: userId },
          update: { googleEmail: email, refreshTokenEnc, connectedById: userId, status: 'CONNECTED', lastError: null, folderId: null },
        });
        await this.audit.record({ action: 'agent.drive.connected', resourceType: 'agent', resourceId: agentId, organizationId: agentId, actor: { type: 'USER', id: userId }, newValue: { google_email: email } }, tx);
      });
      // First backup right away, so the agent sees the folder.
      void this.backup(agentId).catch((err) => this.logger.warn({ err: String(err), agentId }, 'First Drive backup failed'));
      return this.webReturn('connected');
    } catch (err) {
      this.logger.warn({ err: String(err), agentId }, 'Google Drive connect failed');
      return this.webReturn('error');
    }
  }

  async setAutoBackup(actor: Actor, auto: boolean) {
    const agentId = agentOnly(actor);
    const n = await this.prisma.agentDriveConnection.updateMany({ where: { agentId }, data: { autoBackup: auto } });
    if (!n.count) throw new AppError(ErrorCode.NOT_FOUND, 'Google Drive is not connected');
    return this.status(actor);
  }

  async backupNow(actor: Actor) {
    const agentId = agentOnly(actor);
    await this.plans.assertFeature(agentId, 'driveBackup', 'Google Drive backup');
    await this.rateLimit.enforce(BACKUP_LIMIT, agentId);
    const c = await this.prisma.agentDriveConnection.findUnique({ where: { agentId } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, 'Connect Google Drive first');
    try {
      await this.backup(agentId);
    } catch (err) {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, err instanceof DriveError ? err.message : 'Google Drive did not accept the backup. Try again later.');
    }
    return this.status(actor);
  }

  async disconnect(actor: Actor) {
    const agentId = agentOnly(actor);
    const c = await this.prisma.agentDriveConnection.findUnique({ where: { agentId } });
    if (!c) return { disconnected: true };
    try {
      const token = this.encryptor.decrypt(c.refreshTokenEnc, tokenAad(agentId));
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch {
      // Revocation is best effort; the token is deleted either way.
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.agentDriveConnection.delete({ where: { agentId } });
      await this.audit.record({ action: 'agent.drive.disconnected', resourceType: 'agent', resourceId: agentId, organizationId: agentId }, tx);
    });
    return { disconnected: true };
  }

  /** Jobs: daily automatic backups for agents whose plan includes it. */
  async runDue(): Promise<number> {
    if (!this.configured) return 0;
    const due = await this.prisma.agentDriveConnection.findMany({
      where: { autoBackup: true, OR: [{ lastBackupAt: null }, { lastBackupAt: { lt: new Date(Date.now() - AUTO_EVERY_MS) } }] },
      select: { agentId: true },
      take: 50,
    });
    let done = 0;
    for (const { agentId } of due) {
      const { plan } = await this.plans.effective(agentId);
      if (!plan.driveBackup) continue;
      try {
        await this.backup(agentId);
        done += 1;
      } catch (err) {
        this.logger.warn({ err: String(err), agentId }, 'Scheduled Drive backup failed');
      }
    }
    return done;
  }

  // ---- Google API -----------------------------------------------------------------------------------

  private async post<T>(url: string, form: Record<string, string>): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new DriveError(`Google answered ${res.status}`);
    return (await res.json()) as T;
  }

  private async accessToken(agentId: string, refreshTokenEnc: string): Promise<string> {
    const refreshToken = this.encryptor.decrypt(refreshTokenEnc, tokenAad(agentId));
    try {
      const t = await this.post<{ access_token: string }>(TOKEN_URL, {
        client_id: this.config.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: this.config.env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      return t.access_token;
    } catch {
      throw new DriveError('Google Drive access was removed. Connect Google Drive again.');
    }
  }

  private async drive<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new DriveError(res.status === 403 ? 'Google Drive refused the upload (storage full or access removed)' : `Google Drive answered ${res.status}`);
    return (await res.json()) as T;
  }

  private async ensureFolder(token: string, agentId: string, folderId: string | null, shopName: string): Promise<string> {
    if (folderId) {
      const res = await fetch(`${DRIVE}/files/${folderId}?fields=id,trashed`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (res.ok && !((await res.json()) as { trashed?: boolean }).trashed) return folderId;
    }
    const folder = await this.drive<{ id: string }>(token, `${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${shopName} — backup`.slice(0, 120), mimeType: 'application/vnd.google-apps.folder' }),
    });
    await this.prisma.agentDriveConnection.update({ where: { agentId }, data: { folderId: folder.id } });
    return folder.id;
  }

  /** Create or replace a file by name inside the folder. */
  private async upsertFile(token: string, folderId: string, name: string, body: Buffer) {
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`);
    const existing = await this.drive<{ files: { id: string }[] }>(token, `${DRIVE}/files?q=${q}&fields=files(id)&pageSize=1`);
    const id = existing.files[0]?.id;
    if (id) {
      await this.drive(token, `${UPLOAD}/files/${id}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'text/csv' }, body: new Uint8Array(body) });
      return;
    }
    const boundary = `p2a${generateToken(12)}`;
    const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'text/csv' });
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/csv\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.drive(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(multipart) });
  }

  async backup(agentId: string): Promise<void> {
    const c = await this.prisma.agentDriveConnection.findUniqueOrThrow({ where: { agentId } });
    const profile = await this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId }, select: { shopName: true } });
    try {
      const token = await this.accessToken(agentId, c.refreshTokenEnc);
      const folderId = await this.ensureFolder(token, agentId, c.folderId, profile.shopName);
      const monthStart = istMonthStart();
      const month = istDateString(monthStart).slice(0, 7);
      await this.upsertFile(token, folderId, 'transactions-all.csv', await rowsToCsv(this.receipts.transactionRows(agentId, null)));
      await this.upsertFile(token, folderId, `transactions-${month}.csv`, await rowsToCsv(this.receipts.transactionRows(agentId, { gte: monthStart, lt: new Date(Date.now() + 86_400_000) })));
      await this.upsertFile(token, folderId, 'customers.csv', await rowsToCsv(this.receipts.customerRows(agentId)));
      await this.prisma.agentDriveConnection.update({ where: { agentId }, data: { lastBackupAt: new Date(), status: 'CONNECTED', lastError: null } });
    } catch (err) {
      const message = err instanceof DriveError ? err.message : 'Backup failed';
      await this.prisma.agentDriveConnection.update({ where: { agentId }, data: { status: 'ERROR', lastError: message.slice(0, 255) } });
      throw err;
    }
  }
}
