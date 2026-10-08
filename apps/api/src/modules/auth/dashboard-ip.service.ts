import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BlockList } from 'node:net';
import { newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { buildIpList, ipInList, normalizeIp } from '../../common/http/ip-list';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';

const CACHE_MS = 15_000;
const MAX_RULES = 50;

/**
 * Dashboard sign-in IP allowlist (docs/SECURITY.md §1.8). An organization without rules is open; once
 * it has rules, its users can sign in, refresh and call the dashboard API only from those addresses.
 * Checked at password login, second factor, refresh and on every authenticated request (cached 15 s
 * per process, invalidated locally on change).
 */
@Injectable()
export class DashboardIpService {
  private readonly logger = new Logger(DashboardIpService.name);
  private readonly cache = new Map<string, { at: number; list: BlockList | null }>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly config: ApiConfig,
    private readonly audit: AuditService,
  ) {}

  private async listFor(organizationId: string): Promise<BlockList | null> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const rules = await this.prisma.dashboardIpRule.findMany({ where: { organizationId }, select: { cidr: true } });
    const list = rules.length ? buildIpList(rules.map((r) => r.cidr)) : null;
    this.cache.set(organizationId, { at: Date.now(), list });
    return list;
  }

  async isAllowed(organizationId: string, ip: string | null | undefined): Promise<boolean> {
    if (!this.config.env.DASHBOARD_IP_ALLOWLIST_ENFORCED) return true;
    const list = await this.listFor(organizationId);
    return !list || ipInList(list, ip);
  }

  /** Throws IP_NOT_ALLOWED for the current request's address. */
  async assertAllowed(organizationId: string): Promise<void> {
    const ip = RequestContextStore.get()?.ipAddress ?? null;
    if (await this.isAllowed(organizationId, ip)) return;
    this.logger.warn({ organizationId, ip }, 'Dashboard access from an address outside the allowlist');
    throw new AppError(ErrorCode.IP_NOT_ALLOWED, `Sign-in from ${normalizeIp(ip) || 'this network'} is not allowed for your organization. Ask an administrator to add it to the dashboard IP allowlist.`);
  }

  async list(actor: Actor) {
    const rules = await this.prisma.dashboardIpRule.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
    return {
      enforced: this.config.env.DASHBOARD_IP_ALLOWLIST_ENFORCED,
      your_ip: normalizeIp(RequestContextStore.get()?.ipAddress) || null,
      rules: rules.map((r) => ({ id: r.id, cidr: r.cidr, label: r.label, created_at: r.createdAt })),
    };
  }

  async add(actor: Actor, input: { cidr: string; label?: string }) {
    const existing = await this.prisma.dashboardIpRule.findMany({ where: { organizationId: actor.organizationId }, select: { cidr: true } });
    if (existing.some((r) => r.cidr === input.cidr)) throw new AppError(ErrorCode.CONFLICT, 'That address is already on the list');
    if (existing.length >= MAX_RULES) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${MAX_RULES} entries`);
    this.assertKeepsCaller([...existing.map((r) => r.cidr), input.cidr]);
    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dashboardIpRule.create({
        data: { id: newId('dashboardIpRule'), organizationId: actor.organizationId, cidr: input.cidr, label: input.label ?? null, createdById: actor.userId },
      });
      await this.audit.record({ action: 'security.dashboard_ip.added', resourceType: 'dashboard_ip_rule', resourceId: created.id, newValue: { cidr: created.cidr, label: created.label }, metadata: { severity: 'MEDIUM' } }, tx);
      return created;
    });
    this.cache.delete(actor.organizationId);
    return { id: rule.id, cidr: rule.cidr, label: rule.label, created_at: rule.createdAt };
  }

  async remove(actor: Actor, id: string) {
    const rules = await this.prisma.dashboardIpRule.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, cidr: true } });
    const target = rules.find((r) => r.id === id);
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'Entry not found');
    const remaining = rules.filter((r) => r.id !== id).map((r) => r.cidr);
    // Removing the last entry opens access again, which can't lock anyone out.
    if (remaining.length) this.assertKeepsCaller(remaining);
    await this.prisma.$transaction(async (tx) => {
      await tx.dashboardIpRule.delete({ where: { id } });
      await this.audit.record({ action: 'security.dashboard_ip.removed', resourceType: 'dashboard_ip_rule', resourceId: id, oldValue: { cidr: target.cidr }, metadata: { severity: 'MEDIUM' } }, tx);
    });
    this.cache.delete(actor.organizationId);
    return { removed: true };
  }

  /** A change may never shut out the person making it (their own address must stay allowed). */
  private assertKeepsCaller(cidrs: string[]) {
    const ip = RequestContextStore.get()?.ipAddress ?? null;
    if (!ipInList(buildIpList(cidrs), ip)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `This change would block your own address (${normalizeIp(ip) || 'unknown'}). Add your current address first.`,
      );
    }
  }
}
