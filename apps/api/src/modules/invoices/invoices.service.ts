import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type Invoice, isUniqueViolation, notifyInbox, type Prisma, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import { financialYear, gstStateCode, gstStateName, invoiceNumber, type listInvoicesQuerySchema, type taxProfileSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

const IST = 19_800_000;
const CAPTURED_PAYOUT = ['SUCCESS', 'REVERSED'] as const;

interface Line {
  code: 'PAYIN_FEES' | 'PAYOUT_FEES' | 'CHARGEBACK_FEES';
  description: string;
  sac: string;
  count: number;
  taxable_minor: string;
  tax_minor: string;
}

/** [start, end) of a calendar month in IST, as UTC instants. */
export function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1) - IST), end: new Date(Date.UTC(y, m, 1) - IST) };
}

const monthLabel = (start: Date) => new Date(start.getTime() + IST).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Monthly GST tax invoices for the platform's fees (docs/INVOICES.md). One invoice per merchant and
 * month with lines for payin, payout and chargeback fees; GST is the tax already charged on each
 * transaction, split CGST+SGST (same state) or IGST (other state) by place of supply. Serials are
 * gapless per financial year (row-locked counter in the issuing transaction) and invoices are
 * immutable (trigger).
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
  ) {}

  // ---- Tax profile --------------------------------------------------------------------------------

  async taxProfile() {
    const p = await this.prisma.taxProfile.findUnique({ where: { id: 'default' } });
    return p ? { legal_name: p.legalName, gstin: p.gstin, pan: p.pan, address: p.address, state_code: p.stateCode, state: gstStateName(p.stateCode), sac: p.sac, invoice_prefix: p.invoicePrefix, footer_note: p.footerNote, updated_at: p.updatedAt } : null;
  }

  async saveTaxProfile(actor: Actor, input: z.output<typeof taxProfileSchema>) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const data = { legalName: input.legal_name, gstin: input.gstin, pan: input.pan, address: input.address, stateCode: input.state_code, sac: input.sac, invoicePrefix: input.invoice_prefix, footerNote: input.footer_note ?? null, updatedById: actor.userId };
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.taxProfile.findUnique({ where: { id: 'default' } });
      await tx.taxProfile.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: { ...data, version: { increment: 1 } } });
      await this.audit.record({ action: 'tax_profile.updated', resourceType: 'tax_profile', resourceId: 'default', organizationId: null, oldValue: before ? { gstin: before.gstin, legal_name: before.legalName, prefix: before.invoicePrefix } : null, newValue: { gstin: input.gstin, legal_name: input.legal_name, prefix: input.invoice_prefix }, metadata: { reason: input.reason, severity: 'HIGH' } }, tx);
    });
    return this.taxProfile();
  }

  // ---- Reading ------------------------------------------------------------------------------------

  present(i: Invoice) {
    const lines = i.lines as unknown as Line[];
    return {
      id: i.id,
      object: 'invoice',
      number: i.number,
      merchant_id: i.merchantId,
      financial_year: i.financialYear,
      period: { start: i.periodStart, end: i.periodEnd, label: monthLabel(i.periodStart) },
      issue_date: i.issueDate,
      seller: i.seller,
      buyer: i.buyer,
      place_of_supply: i.placeOfSupply ? { code: i.placeOfSupply, state: gstStateName(i.placeOfSupply) } : null,
      inter_state: i.interState,
      lines: lines.map((l) => ({ code: l.code, description: l.description, sac: l.sac, count: l.count, taxable: minorToMajorString(BigInt(l.taxable_minor)), tax: minorToMajorString(BigInt(l.tax_minor)) })),
      taxable: minorToMajorString(i.taxableMinor),
      cgst: minorToMajorString(i.cgstMinor),
      sgst: minorToMajorString(i.sgstMinor),
      igst: minorToMajorString(i.igstMinor),
      total: minorToMajorString(i.totalMinor),
      commission_credited: minorToMajorString(i.commissionMinor),
      created_at: i.createdAt,
    };
  }

  async list(actor: Actor, q: z.output<typeof listInvoicesQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const merchant = q.merchant_id ? (ids && !ids.includes(q.merchant_id) ? { merchantId: '__none__' } : { merchantId: q.merchant_id }) : ids ? { merchantId: { in: ids } } : {};
    const rows = await this.prisma.invoice.findMany({
      where: { AND: [merchant, q.month ? { periodStart: monthRange(q.month).start } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (i) => this.present(i));
  }

  async get(actor: Actor, id: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const i = await this.prisma.invoice.findFirst({ where: { id, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!i) throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');
    return this.present(i);
  }

  // ---- Issuing ------------------------------------------------------------------------------------

  private async lines(merchantId: string, start: Date, end: Date, sac: string): Promise<{ lines: Line[]; commissionMinor: bigint }> {
    const [payin, payout, chargebacks] = await Promise.all([
      this.prisma.payment.aggregate({ where: { merchantId, captureJournalId: { not: null }, successAt: { gte: start, lt: end } }, _sum: { feeMinor: true, taxMinor: true, commissionMinor: true }, _count: { _all: true } }),
      this.prisma.payout.aggregate({ where: { merchantId, status: { in: [...CAPTURED_PAYOUT] }, processedAt: { gte: start, lt: end } }, _sum: { feeMinor: true, taxMinor: true }, _count: { _all: true } }),
      this.prisma.dispute.aggregate({ where: { merchantId, status: 'LOST', feeMinor: { gt: 0n }, resolvedAt: { gte: start, lt: end } }, _sum: { feeMinor: true, taxMinor: true }, _count: { _all: true } }),
    ]);
    const lines: Line[] = [];
    const add = (code: Line['code'], description: string, count: number, fee: bigint | null, tax: bigint | null) => {
      if ((fee ?? 0n) > 0n) lines.push({ code, description, sac, count, taxable_minor: (fee ?? 0n).toString(), tax_minor: (tax ?? 0n).toString() });
    };
    add('PAYIN_FEES', 'Payment collection (payin) service fees', payin._count._all, payin._sum.feeMinor, payin._sum.taxMinor);
    add('PAYOUT_FEES', 'Payout (disbursement) service fees', payout._count._all, payout._sum.feeMinor, payout._sum.taxMinor);
    add('CHARGEBACK_FEES', 'Chargeback handling fees', chargebacks._count._all, chargebacks._sum.feeMinor, chargebacks._sum.taxMinor);
    return { lines, commissionMinor: payin._sum.commissionMinor ?? 0n };
  }

  /** Issue the month's invoice for one merchant. Returns null when there is nothing to invoice or it exists. */
  async issue(merchantId: string, month: string): Promise<Invoice | null> {
    const profile = await this.prisma.taxProfile.findUnique({ where: { id: 'default' } });
    if (!profile) throw new AppError(ErrorCode.INVALID_REQUEST, 'Set up the platform tax profile (Settings → Tax & invoices) first');
    const { start, end } = monthRange(month);
    if (end.getTime() > Date.now()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invoices are issued after the month ends');
    if (await this.prisma.invoice.findUnique({ where: { merchantId_periodStart: { merchantId, periodStart: start } }, select: { id: true } })) return null;
    const { lines, commissionMinor } = await this.lines(merchantId, start, end, profile.sac);
    if (!lines.length) return null;

    const m = await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { organization: { select: { name: true } }, profile: { select: { legalName: true, gstin: true, registeredAddress: true } } } });
    const addr = (m.profile?.registeredAddress ?? null) as { line1?: string; line2?: string; city?: string; state?: string; pincode?: string } | null;
    const buyerState = gstStateCode(m.profile?.gstin, addr?.state);
    const placeOfSupply = buyerState ?? profile.stateCode;
    const interState = placeOfSupply !== profile.stateCode;
    const taxable = lines.reduce((n, l) => n + BigInt(l.taxable_minor), 0n);
    const tax = lines.reduce((n, l) => n + BigInt(l.tax_minor), 0n);
    const cgst = interState ? 0n : tax / 2n;
    const sgst = interState ? 0n : tax - cgst;
    const igst = interState ? tax : 0n;
    const issueDate = new Date();
    const fy = financialYear(issueDate);
    const seller = { legal_name: profile.legalName, gstin: profile.gstin, pan: profile.pan, address: profile.address, state_code: profile.stateCode, state: gstStateName(profile.stateCode), footer_note: profile.footerNote };
    const buyer = {
      merchant_id: merchantId,
      name: m.profile?.legalName ?? m.organization.name,
      trade_name: m.organization.name,
      gstin: m.profile?.gstin ?? null,
      address: addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') : null,
      state_code: buyerState,
      state: gstStateName(buyerState),
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Gapless serial: the counter row stays locked until this invoice commits (or both roll back).
        await tx.$executeRaw`INSERT INTO invoice_sequences (financial_year, last_serial) VALUES (${fy}, 0) ON CONFLICT (financial_year) DO NOTHING`;
        const [row] = await tx.$queryRaw<{ last_serial: number }[]>`UPDATE invoice_sequences SET last_serial = last_serial + 1 WHERE financial_year = ${fy} RETURNING last_serial`;
        const invoice = await tx.invoice.create({
          data: {
            id: newId('invoice'),
            merchantId,
            number: invoiceNumber(profile.invoicePrefix, fy, row!.last_serial),
            financialYear: fy,
            periodStart: start,
            periodEnd: end,
            issueDate,
            seller,
            buyer,
            placeOfSupply,
            interState,
            lines: lines as unknown as Prisma.InputJsonValue,
            taxableMinor: taxable,
            cgstMinor: cgst,
            sgstMinor: sgst,
            igstMinor: igst,
            totalMinor: taxable + cgst + sgst + igst,
            commissionMinor,
          },
        });
        await this.audit.record({ action: 'invoice.issued', resourceType: 'invoice', resourceId: invoice.id, organizationId: merchantId, actor: { type: 'SYSTEM', id: null }, newValue: { number: invoice.number, month, total: minorToMajorString(invoice.totalMinor) } }, tx);
        await notifyInbox(tx, { organizationId: merchantId, audience: { permission: 'report.read' }, category: 'REPORT', severity: 'INFO', title: `Tax invoice ${invoice.number} for ${monthLabel(start)}`, body: `Fees ₹${minorToMajorString(taxable)} + GST ₹${minorToMajorString(tax)} = ₹${minorToMajorString(invoice.totalMinor)} (already deducted from your transactions).`, link: `/accounts/invoices/${invoice.id}`, resourceType: 'invoice', resourceId: invoice.id, dedupeKey: `invoice:${invoice.id}:issued` });
        return invoice;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return null; // issued concurrently
      throw err;
    }
  }

  /** Issue a month's invoices for every merchant with fees in it (or one merchant). */
  async generate(month: string, merchantId?: string) {
    const { start, end } = monthRange(month);
    if (!(await this.prisma.taxProfile.findUnique({ where: { id: 'default' }, select: { id: true } }))) throw new AppError(ErrorCode.INVALID_REQUEST, 'Set up the platform tax profile (Settings → Tax & invoices) first');
    if (end.getTime() > Date.now()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Invoices are issued after the month ends');
    const ids = merchantId
      ? [merchantId]
      : [
          ...new Set(
            (
              await Promise.all([
                this.prisma.payment.findMany({ where: { captureJournalId: { not: null }, successAt: { gte: start, lt: end }, feeMinor: { gt: 0n } }, distinct: ['merchantId'], select: { merchantId: true } }),
                this.prisma.payout.findMany({ where: { status: { in: [...CAPTURED_PAYOUT] }, processedAt: { gte: start, lt: end }, feeMinor: { gt: 0n } }, distinct: ['merchantId'], select: { merchantId: true } }),
                this.prisma.dispute.findMany({ where: { status: 'LOST', feeMinor: { gt: 0n }, resolvedAt: { gte: start, lt: end } }, distinct: ['merchantId'], select: { merchantId: true } }),
              ])
            )
              .flat()
              .map((r) => r.merchantId),
          ),
        ];
    let issued = 0;
    for (const id of ids) if (await this.issue(id, month)) issued++;
    return { month, merchants: ids.length, issued };
  }

  async generateAs(actor: Actor, month: string, merchantId?: string) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const result = await this.generate(month, merchantId);
    await this.audit.record({ action: 'invoice.generated', resourceType: 'invoice', resourceId: null, organizationId: null, metadata: result });
    return result;
  }

  /** Job: from the 1st of each month (IST), issue the previous month's invoices once a tax profile exists. */
  async generateDue(): Promise<number> {
    if (!(await this.prisma.taxProfile.findUnique({ where: { id: 'default' }, select: { id: true } }))) return 0;
    const now = new Date(Date.now() + IST);
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    const r = await this.generate(month);
    if (r.issued) this.logger.log(r, 'Monthly invoices issued');
    return r.issued;
  }
}
