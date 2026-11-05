import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { AgentProfile, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { agentProfileUpdateSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { inspectImage } from '../brand/image-inspect';
import { agentOnly, istDayStart, istMonthStart, money, presentPlan } from './agent-common';
import { AgentPlansService } from './agent-plans.service';
import { presentTransaction } from './agent-presenters';

type Tx = Prisma.TransactionClient;
const IMAGE_MAX = 2 * 1024 * 1024;

function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'agent';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateAgentInput {
  shopName: string;
  ownerName: string;
  email: string;
  mobile: string;
  /** Referring reseller / partner, else the platform. */
  parentId: string | null;
  source: string;
}

@Injectable()
export class AgentProfileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly plans: AgentPlansService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Organization (type AGENT) + profile on the Free plan. The caller adds the owner membership. */
  async createInTx(tx: Tx, input: CreateAgentInput): Promise<string> {
    const platform = await tx.organization.findFirstOrThrow({ where: { type: 'PLATFORM' }, select: { id: true } });
    const free = await this.plans.byCode('FREE', tx);
    const id = newId('organization');
    await tx.organization.create({ data: { id, type: 'AGENT', name: input.shopName, slug: slugify(input.shopName), parentId: input.parentId ?? platform.id, source: input.source } });
    await tx.agentProfile.create({ data: { id, shopName: input.shopName, ownerName: input.ownerName, email: input.email, mobile: input.mobile, planId: free.id, upiPayeeName: input.shopName } });
    return id;
  }

  present(p: AgentProfile) {
    return {
      id: p.id,
      shop_name: p.shopName,
      owner_name: p.ownerName,
      email: p.email,
      mobile: p.mobile,
      address_line: p.addressLine,
      city: p.city,
      state: p.state,
      pincode: p.pincode,
      upi_vpa: p.upiVpa,
      upi_payee_name: p.upiPayeeName,
      has_qr_image: Boolean(p.qrImageKey),
      has_logo: Boolean(p.logoKey),
      receipt_footer: p.receiptFooter,
      created_at: p.createdAt,
    };
  }

  async get(actor: Actor) {
    const agentId = agentOnly(actor);
    const [profile, eff, usage] = await Promise.all([
      this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId } }),
      this.plans.effective(agentId),
      this.plans.usage(agentId),
    ]);
    return {
      ...this.present(profile),
      plan: { ...presentPlan(eff.plan), expires_at: eff.lapsed ? null : eff.expiresAt, lapsed_from: eff.lapsed ? eff.subscribed.code : null },
      usage,
    };
  }

  async update(actor: Actor, input: z.output<typeof agentProfileUpdateSchema>) {
    const agentId = agentOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.agentProfile.findUniqueOrThrow({ where: { id: agentId } });
      const data = {
        ...(input.shop_name !== undefined ? { shopName: input.shop_name } : {}),
        ...(input.owner_name !== undefined ? { ownerName: input.owner_name } : {}),
        ...(input.address_line !== undefined ? { addressLine: input.address_line } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
        ...(input.upi_vpa !== undefined ? { upiVpa: input.upi_vpa } : {}),
        ...(input.upi_payee_name !== undefined ? { upiPayeeName: input.upi_payee_name } : {}),
        ...(input.receipt_footer !== undefined ? { receiptFooter: input.receipt_footer } : {}),
      };
      await tx.agentProfile.update({ where: { id: agentId }, data });
      if (input.shop_name && input.shop_name !== before.shopName) await tx.organization.update({ where: { id: agentId }, data: { name: input.shop_name } });
      await this.audit.record({ action: 'agent.profile.updated', resourceType: 'agent', resourceId: agentId, organizationId: agentId, oldValue: { upi_vpa: before.upiVpa, shop_name: before.shopName }, newValue: { fields: Object.keys(input) } }, tx);
    });
    return this.get(actor);
  }

  /** Upload the shop's own QR image (e.g. from its bank) or logo. PNG/JPEG/WebP up to 2 MB. */
  async uploadImage(actor: Actor, kind: 'qr' | 'logo', file: { buffer: Buffer; size: number } | undefined) {
    const agentId = agentOnly(actor);
    if (!file || file.size === 0) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose an image');
    if (file.size > IMAGE_MAX) throw new AppError(ErrorCode.INVALID_REQUEST, 'The image can be at most 2 MB');
    let type = '';
    try {
      type = inspectImage(file.buffer).type;
    } catch {
      type = '';
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new AppError(ErrorCode.INVALID_REQUEST, 'Upload a PNG, JPEG or WebP image');
    const key = `agents/${agentId}/${kind}-${Date.now()}`;
    await this.storage.put(key, file.buffer, type, createHash('sha256').update(file.buffer).digest('hex'));
    const before = await this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId }, select: { qrImageKey: true, logoKey: true } });
    await this.prisma.agentProfile.update({ where: { id: agentId }, data: kind === 'qr' ? { qrImageKey: key } : { logoKey: key } });
    const old = kind === 'qr' ? before.qrImageKey : before.logoKey;
    if (old) await this.storage.delete(old).catch(() => undefined);
    await this.audit.record({ action: `agent.${kind}.uploaded`, resourceType: 'agent', resourceId: agentId, organizationId: agentId });
    return this.get(actor);
  }

  async removeImage(actor: Actor, kind: 'qr' | 'logo') {
    const agentId = agentOnly(actor);
    const before = await this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId }, select: { qrImageKey: true, logoKey: true } });
    await this.prisma.agentProfile.update({ where: { id: agentId }, data: kind === 'qr' ? { qrImageKey: null } : { logoKey: null } });
    const old = kind === 'qr' ? before.qrImageKey : before.logoKey;
    if (old) await this.storage.delete(old).catch(() => undefined);
    return this.get(actor);
  }

  /** Stream an image by agent id (also used by the public receipt for the logo). */
  async image(agentId: string, kind: 'qr' | 'logo') {
    const p = await this.prisma.agentProfile.findUnique({ where: { id: agentId }, select: { qrImageKey: true, logoKey: true } });
    const key = kind === 'qr' ? p?.qrImageKey : p?.logoKey;
    if (!key) throw new AppError(ErrorCode.NOT_FOUND, 'No image');
    const row = await this.prisma.storageObject.findUnique({ where: { key }, select: { contentType: true } });
    return { stream: await this.storage.getStream(key), type: row?.contentType ?? 'image/png' };
  }

  async dashboard(actor: Actor) {
    const agentId = agentOnly(actor);
    const today = istDayStart();
    const month = istMonthStart();
    const counted = { agentId, status: { in: ['SUCCESS', 'PENDING'] as ('SUCCESS' | 'PENDING')[] } };
    const [todayRows, monthAgg, recent, customers, profile] = await Promise.all([
      this.prisma.agentTransaction.groupBy({ by: ['direction'], where: { ...counted, occurredAt: { gte: today } }, _sum: { amountMinor: true, feeMinor: true }, _count: true }),
      this.prisma.agentTransaction.aggregate({ where: { ...counted, occurredAt: { gte: month } }, _sum: { amountMinor: true, feeMinor: true }, _count: true }),
      this.prisma.agentTransaction.findMany({ where: { agentId }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 8 }),
      this.prisma.agentCustomer.count({ where: { agentId } }),
      this.get(actor),
    ]);
    const sum = (dir: 'IN' | 'OUT') => todayRows.find((r) => r.direction === dir);
    const inMinor = sum('IN')?._sum.amountMinor ?? 0n;
    const outMinor = sum('OUT')?._sum.amountMinor ?? 0n;
    const feesToday = (sum('IN')?._sum.feeMinor ?? 0n) + (sum('OUT')?._sum.feeMinor ?? 0n);
    return {
      profile,
      today: {
        money_in: money(inMinor),
        money_out: money(outMinor),
        fees: money(feesToday),
        /** Cash/UPI in minus cash out plus fees: the change in the counter today. */
        net: money(inMinor - outMinor + feesToday),
        count: (sum('IN')?._count ?? 0) + (sum('OUT')?._count ?? 0),
      },
      month: { volume: money(monthAgg._sum.amountMinor), fees: money(monthAgg._sum.feeMinor), count: monthAgg._count },
      customers,
      recent: recent.map(presentTransaction),
    };
  }
}
