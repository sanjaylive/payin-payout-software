import { Inject, Injectable } from '@nestjs/common';
import type { AgentTransaction, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { agentReportQuerySchema, agentSendReceiptSchema } from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { CsvWriter } from '../reports/report-writer';
import { agentOnly, istDateString, istRange, money } from './agent-common';
import { AgentPlansService } from './agent-plans.service';
import { presentTransaction } from './agent-presenters';

const TYPE_LABEL: Record<string, string> = {
  MONEY_TRANSFER: 'Money transfer',
  CASH_WITHDRAWAL: 'Cash withdrawal',
  CASH_DEPOSIT: 'Cash deposit',
  BILL_PAYMENT: 'Bill payment',
  RECHARGE: 'Recharge',
  OTHER: 'Other',
};

const SEND_LIMIT = { name: 'agent-receipt-send', limit: 60, windowSeconds: 3600 } as const;
const CSV_MAX_ROWS = 50_000;

/** Receipts (printable, public link, SMS/WhatsApp) and reports for agents (docs/AGENTS.md §4–5). */
@Injectable()
export class AgentReceiptsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly plans: AgentPlansService,
    private readonly notifications: NotificationsService,
    private readonly rateLimit: RateLimitService,
    private readonly brand: BrandService,
    private readonly config: ApiConfig,
    private readonly audit: AuditService,
  ) {}

  private webBase() {
    return this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '');
  }

  /** Everything a receipt shows. Branding (logo, footer) only on plans that include it. */
  private async receipt(t: AgentTransaction) {
    const [profile, eff, platform] = await Promise.all([
      this.prisma.agentProfile.findUniqueOrThrow({ where: { id: t.agentId } }),
      this.plans.effective(t.agentId),
      this.brand.forOrganization(t.agentId),
    ]);
    const branded = eff.plan.brandedReceipts;
    return {
      transaction: presentTransaction(t),
      type_label: TYPE_LABEL[t.type] ?? t.type,
      shop: {
        name: profile.shopName,
        mobile: profile.mobile,
        address: [profile.addressLine, profile.city, profile.state, profile.pincode].filter(Boolean).join(', ') || null,
        upi_vpa: profile.upiVpa,
        logo_url: branded && profile.logoKey ? `/v1/public/agent-receipts/${t.receiptToken}/logo` : null,
        footer: branded ? profile.receiptFooter : null,
      },
      branded,
      powered_by: branded ? null : platform.product_name,
      public_url: `${this.webBase()}/r/${t.receiptToken}`,
    };
  }

  async forAgent(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const t = await this.prisma.agentTransaction.findFirst({ where: { id, agentId } });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, 'Transaction not found');
    return this.receipt(t);
  }

  /** The customer's link. The token is 192 random bits; nothing else about the agent is exposed. */
  async publicByToken(token: string) {
    const t = await this.prisma.agentTransaction.findUnique({ where: { receiptToken: token } });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, 'Receipt not found');
    const r = await this.receipt(t);
    const { receipt_token: _token, created_by: _by, ...transaction } = r.transaction;
    return { ...r, transaction };
  }

  async agentIdForToken(token: string) {
    const t = await this.prisma.agentTransaction.findUnique({ where: { receiptToken: token }, select: { agentId: true } });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, 'Receipt not found');
    return t.agentId;
  }

  async send(actor: Actor, id: string, input: z.output<typeof agentSendReceiptSchema>) {
    const agentId = agentOnly(actor);
    await this.plans.assertFeature(agentId, 'messaging', 'Sending receipts by SMS / WhatsApp');
    await this.rateLimit.enforce(SEND_LIMIT, agentId);
    const t = await this.prisma.agentTransaction.findFirst({ where: { id, agentId } });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, 'Transaction not found');
    const to = input.mobile ?? t.customerMobile;
    if (!to) throw new AppError(ErrorCode.INVALID_REQUEST, 'Add the customer’s mobile number', [{ path: 'mobile', message: 'Required' }]);
    const profile = await this.prisma.agentProfile.findUniqueOrThrow({ where: { id: agentId }, select: { shopName: true } });
    const link = `${this.webBase()}/r/${t.receiptToken}`;
    const amount = money(t.amountMinor);
    await this.prisma.$transaction(async (tx) => {
      await this.notifications.queue(tx, {
        channel: input.channel,
        to,
        template: 'agent_receipt',
        variables: { shop: profile.shopName, receipt_no: t.receiptNo, amount, type: TYPE_LABEL[t.type] ?? t.type, link },
        text: `${profile.shopName}: ${TYPE_LABEL[t.type]} of Rs ${amount} (receipt ${t.receiptNo}, ${t.status.toLowerCase()}). View: ${link}`,
      });
      await tx.agentTransaction.update({ where: { id }, data: { receiptSentAt: new Date() } });
      await this.audit.record({ action: 'agent.receipt.sent', resourceType: 'agent_transaction', resourceId: id, organizationId: agentId, metadata: { channel: input.channel } }, tx);
    });
    return { sent: true, channel: input.channel };
  }

  // ---- Reports ------------------------------------------------------------------------------------

  async summary(actor: Actor, q: z.output<typeof agentReportQuerySchema>) {
    const agentId = agentOnly(actor);
    const range = istRange(q.from, q.to);
    const where = { agentId, occurredAt: range };
    const counted = { ...where, status: { in: ['SUCCESS' as const, 'PENDING' as const] } };
    const [byType, byMode, byStatus, rows] = await Promise.all([
      this.prisma.agentTransaction.groupBy({ by: ['type', 'direction'], where: counted, _sum: { amountMinor: true, feeMinor: true }, _count: true }),
      this.prisma.agentTransaction.groupBy({ by: ['mode', 'direction'], where: counted, _sum: { amountMinor: true }, _count: true }),
      this.prisma.agentTransaction.groupBy({ by: ['status'], where, _sum: { amountMinor: true }, _count: true }),
      this.prisma.agentTransaction.findMany({ where: counted, select: { occurredAt: true, direction: true, amountMinor: true, feeMinor: true } }),
    ]);
    let inMinor = 0n;
    let outMinor = 0n;
    let fees = 0n;
    const days = new Map<string, { in: bigint; out: bigint; fees: bigint; count: number }>();
    for (const r of rows) {
      const d = istDateString(r.occurredAt);
      const day = days.get(d) ?? { in: 0n, out: 0n, fees: 0n, count: 0 };
      if (r.direction === 'IN') {
        inMinor += r.amountMinor;
        day.in += r.amountMinor;
      } else {
        outMinor += r.amountMinor;
        day.out += r.amountMinor;
      }
      fees += r.feeMinor;
      day.fees += r.feeMinor;
      day.count += 1;
      days.set(d, day);
    }
    return {
      from: q.from,
      to: q.to,
      totals: { money_in: money(inMinor), money_out: money(outMinor), fees: money(fees), net: money(inMinor - outMinor + fees), count: rows.length },
      by_type: byType.map((r) => ({ type: r.type, label: TYPE_LABEL[r.type], direction: r.direction, amount: money(r._sum.amountMinor), fees: money(r._sum.feeMinor), count: r._count })),
      by_mode: byMode.map((r) => ({ mode: r.mode, direction: r.direction, amount: money(r._sum.amountMinor), count: r._count })),
      by_status: byStatus.map((r) => ({ status: r.status, amount: money(r._sum.amountMinor), count: r._count })),
      by_day: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, money_in: money(v.in), money_out: money(v.out), fees: money(v.fees), net: money(v.in - v.out + v.fees), count: v.count })),
    };
  }

  /** Rows for a CSV export (also used by the Google Drive backup). */
  async *transactionRows(agentId: string, range: { gte: Date; lt: Date } | null) {
    yield ['Receipt', 'Date (IST)', 'Type', 'Direction', 'Mode', 'Status', 'Amount', 'Fee', 'Customer', 'Customer mobile', 'Beneficiary', 'Bank', 'Account', 'IFSC', 'UPI', 'Reference', 'Note', 'Recorded by'];
    let cursor: { occurredAt: Date; id: string } | null = null;
    let total = 0;
    for (;;) {
      const batch: AgentTransaction[] = await this.prisma.agentTransaction.findMany({
        where: { agentId, ...(range ? { occurredAt: range } : {}), ...(cursor ? { OR: [{ occurredAt: { gt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { gt: cursor.id } }] } : {}) },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: 1000,
      });
      for (const t of batch) {
        yield [
          t.receiptNo,
          new Date(t.occurredAt.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' '),
          TYPE_LABEL[t.type],
          t.direction,
          t.mode,
          t.status,
          money(t.amountMinor),
          money(t.feeMinor),
          t.customerName,
          t.customerMobile,
          t.beneficiaryName,
          t.beneficiaryBank,
          t.beneficiaryAccount,
          t.beneficiaryIfsc,
          t.beneficiaryUpi,
          t.reference,
          t.description,
          t.createdByName,
        ];
      }
      total += batch.length;
      if (batch.length < 1000 || total >= CSV_MAX_ROWS) return;
      const last = batch[batch.length - 1]!;
      cursor = { occurredAt: last.occurredAt, id: last.id };
    }
  }

  async *customerRows(agentId: string) {
    yield ['Name', 'Mobile', 'Email', 'Address', 'City', 'PIN', 'ID type', 'ID (last 4)', 'Added on'];
    const rows = await this.prisma.agentCustomer.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' }, take: CSV_MAX_ROWS });
    for (const c of rows) yield [c.name, c.mobile, c.email, c.addressLine, c.city, c.pincode, c.idType, c.idNumberLast4, istDateString(c.createdAt)];
  }

  async exportCsv(actor: Actor, q: z.output<typeof agentReportQuerySchema>, res: Response) {
    const agentId = agentOnly(actor);
    const range = istRange(q.from, q.to);
    await this.audit.record({ action: 'agent.report.exported', resourceType: 'agent', resourceId: agentId, organizationId: agentId, metadata: { from: q.from, to: q.to } });
    const w = new CsvWriter();
    res.setHeader('Content-Type', w.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${q.from}-to-${q.to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    w.stream.pipe(res);
    let header = true;
    for await (const row of this.transactionRows(agentId, range)) {
      if (header) {
        await w.writeHeader(row as string[]);
        header = false;
      } else await w.writeRow(row);
    }
    await w.end();
  }
}
