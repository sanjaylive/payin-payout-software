import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, SalesLead } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { convertLeadSchema, createLeadSchema, listLeadsQuerySchema, salesAssignmentSchema, updateLeadSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { MerchantsService } from '../merchants/merchants.service';

interface LeadNote {
  at: string;
  by: string;
  text: string;
}

function presentLead(l: SalesLead) {
  return {
    id: l.id,
    company_name: l.companyName,
    contact_name: l.contactName,
    contact_email: l.contactEmail,
    contact_mobile: l.contactMobile,
    source: l.source,
    expected_monthly_volume: l.expectedMonthlyVolume,
    status: l.status,
    assigned_sales_user_id: l.assignedSalesUserId,
    follow_up_date: l.followUpDate?.toISOString().slice(0, 10) ?? null,
    notes: l.notes as unknown as LeadNote[],
    converted_merchant_id: l.convertedMerchantId,
    converted_at: l.convertedAt,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

/** Basic onboarding CRM for platform sales staff (permissions are PLATFORM-scoped). */
@Injectable()
export class SalesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly merchants: MerchantsService,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Assignees must be active platform staff with sales access. */
  private async assertSalesUser(userId: string) {
    const ok = await this.prisma.userRole.count({
      where: {
        userId,
        organization: { type: 'PLATFORM' },
        user: { status: 'ACTIVE' },
        role: { permissions: { some: { permissionKey: 'sales.read' } } },
      },
    });
    if (!ok) throw new AppError(ErrorCode.INVALID_REQUEST, 'Assignee must be an active platform user with sales access');
  }

  async list(actor: Actor, q: z.output<typeof listLeadsQuerySchema>) {
    const assignee = q.assigned_to === 'me' ? actor.userId : q.assigned_to;
    const rows = await this.prisma.salesLead.findMany({
      where: {
        AND: [
          q.status ? { status: q.status } : {},
          assignee ? { assignedSalesUserId: assignee } : {},
          q.search ? { OR: [{ companyName: { contains: q.search, mode: 'insensitive' } }, { contactName: { contains: q.search, mode: 'insensitive' } }] } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentLead);
  }

  async get(id: string) {
    const lead = await this.prisma.salesLead.findUnique({ where: { id } });
    if (!lead) throw new AppError(ErrorCode.NOT_FOUND, 'Lead not found');
    return presentLead(lead);
  }

  async create(actor: Actor, input: z.output<typeof createLeadSchema>) {
    const assignee = input.assigned_sales_user_id ?? actor.userId;
    await this.assertSalesUser(assignee);
    const notes: LeadNote[] = input.notes ? [{ at: new Date().toISOString(), by: actor.userId, text: input.notes }] : [];
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.salesLead.create({
        data: {
          id: newId('salesLead'),
          companyName: input.company_name,
          contactName: input.contact_name,
          contactEmail: input.contact_email ?? null,
          contactMobile: input.contact_mobile ?? null,
          source: input.source,
          expectedMonthlyVolume: input.expected_monthly_volume ?? null,
          followUpDate: input.follow_up_date ? new Date(input.follow_up_date) : null,
          assignedSalesUserId: assignee,
          notes: notes as unknown as Prisma.InputJsonValue,
          createdById: actor.userId,
        },
      });
      await this.audit.record({ action: 'sales.lead.created', resourceType: 'sales_lead', resourceId: lead.id, newValue: presentLead(lead) }, tx);
      return presentLead(lead);
    });
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateLeadSchema>) {
    if (input.assigned_sales_user_id) await this.assertSalesUser(input.assigned_sales_user_id);
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.salesLead.findUnique({ where: { id } });
      if (!lead) throw new AppError(ErrorCode.NOT_FOUND, 'Lead not found');
      if (lead.status === 'CONVERTED') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Converted leads are read-only');
      const notes = lead.notes as unknown as LeadNote[];
      const updated = await tx.salesLead.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.follow_up_date !== undefined ? { followUpDate: input.follow_up_date ? new Date(input.follow_up_date) : null } : {}),
          ...(input.assigned_sales_user_id !== undefined ? { assignedSalesUserId: input.assigned_sales_user_id } : {}),
          ...(input.note ? { notes: [...notes, { at: new Date().toISOString(), by: actor.userId, text: input.note }] as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      await this.audit.record(
        { action: 'sales.lead.updated', resourceType: 'sales_lead', resourceId: id, oldValue: { status: lead.status, assigned: lead.assignedSalesUserId, follow_up: lead.followUpDate }, newValue: { status: updated.status, assigned: updated.assignedSalesUserId, follow_up: updated.followUpDate } },
        tx,
      );
      return presentLead(updated);
    });
  }

  /** Convert a qualified lead into a DRAFT merchant, carrying over the sales owner and source. */
  async convert(actor: Actor, id: string, input: z.output<typeof convertLeadSchema>) {
    const resellerId = await this.merchants.resolveReseller(actor, input.reseller_id);
    const merchantId = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.salesLead.findUnique({ where: { id } });
      if (!lead) throw new AppError(ErrorCode.NOT_FOUND, 'Lead not found');
      // Conditional claim prevents double conversion under concurrency.
      const claimed = await tx.salesLead.updateMany({ where: { id, status: { notIn: ['CONVERTED', 'LOST'] } }, data: { status: 'CONVERTED', convertedAt: new Date() } });
      if (claimed.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Lead is ${lead.status.toLowerCase()} and cannot be converted`);
      const mid = await this.merchants.createInTx(tx, actor, {
        displayName: lead.companyName,
        resellerId,
        source: `lead:${lead.id}`,
        assignedSalesUserId: lead.assignedSalesUserId,
      });
      await tx.merchantProfile.update({
        where: { merchantId: mid },
        data: { contactName: lead.contactName, contactEmail: lead.contactEmail, contactMobile: lead.contactMobile },
      });
      await tx.salesLead.update({ where: { id }, data: { convertedMerchantId: mid } });
      await this.audit.record({ action: 'sales.lead.converted', resourceType: 'sales_lead', resourceId: id, newValue: { merchant_id: mid } }, tx);
      return mid;
    });
    return { merchant_id: merchantId };
  }

  /** Assign a sales owner to a reseller or merchant organization. */
  async assign(actor: Actor, organizationId: string, input: z.output<typeof salesAssignmentSchema>) {
    const org = await this.scope.requireOrganization(actor, organizationId);
    if (org.type !== 'RESELLER' && org.type !== 'MERCHANT') throw new AppError(ErrorCode.INVALID_REQUEST, 'Only resellers and merchants have sales owners');
    if (input.assigned_sales_user_id) await this.assertSalesUser(input.assigned_sales_user_id);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { assignedSalesUserId: true } });
      await tx.organization.update({ where: { id: organizationId }, data: { assignedSalesUserId: input.assigned_sales_user_id } });
      await this.audit.record({ action: 'sales.assignment.updated', resourceType: 'organization', resourceId: organizationId, organizationId, oldValue: { assigned_sales_user_id: before.assignedSalesUserId }, newValue: input }, tx);
    });
    return { organization_id: organizationId, assigned_sales_user_id: input.assigned_sales_user_id };
  }

  /** Platform users who can own sales relationships (for assignment pickers). */
  async salesUsers() {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', memberships: { some: { organization: { type: 'PLATFORM' }, role: { permissions: { some: { permissionKey: 'sales.read' } } } } } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return users;
  }
}
