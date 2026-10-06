import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type BulkPayoutRow, isUniqueViolation, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import { BULK_CSV_COLUMNS, BULK_MAX_ROWS, bulkRowSchema, createPayoutSchema, parseCsv } from '@pay2all/validation';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LimitsService } from '../limits/limits.service';
import { BeneficiariesService } from './beneficiaries.service';
import { presentBatch } from './payout.presenter';
import { PayoutsService, VERIFIED_BENEFICIARY_ABOVE_MINOR } from './payouts.service';

export const BULK_MAX_BYTES = 1024 * 1024;
const ROWS_PER_TICK = 50;
const REQUIRED = ['merchant_order_id', 'amount', 'mode', 'beneficiary_name'] as const;

/**
 * Bulk payouts (docs/PAYOUT_FLOW.md §9). The CSV is validated synchronously (≤ 1,000 rows) and never
 * stored: account numbers go straight into encrypted beneficiaries, rows keep only a beneficiary
 * reference. After the maker confirms, the jobs process creates each row through the normal payout
 * service with key `bulk_<batch>_<row>`, so a half-processed batch can be resumed safely.
 */
@Injectable()
export class BulkPayoutsService {
  private readonly logger = new Logger(BulkPayoutsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly beneficiaries: BeneficiariesService,
    private readonly payouts: PayoutsService,
    private readonly limits: LimitsService,
    private readonly audit: AuditService,
  ) {}

  private async requireBatch(actor: Actor, id: string) {
    const b = await this.prisma.bulkPayoutBatch.findUnique({ where: { id } });
    if (!b || (actor.organizationType === 'MERCHANT' && b.merchantId !== actor.organizationId)) throw new AppError(ErrorCode.NOT_FOUND, 'Batch not found');
    if (actor.organizationType !== 'MERCHANT' && actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.NOT_FOUND, 'Batch not found');
    return b;
  }

  async upload(actor: Actor, file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Bulk payouts are created by merchant accounts');
    if (!file) throw new AppError(ErrorCode.INVALID_REQUEST, 'Attach a CSV file');
    if (file.size > BULK_MAX_BYTES) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file is larger than 1 MB');
    const merchantId = actor.organizationId;
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const dupe = await this.prisma.bulkPayoutBatch.findUnique({ where: { merchantId_fileHash: { merchantId, fileHash } } });
    if (dupe) throw new AppError(ErrorCode.CONFLICT, `This exact file was already uploaded (batch ${dupe.id})`);

    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file is not a text CSV');
    const [header, ...lines] = parseCsv(text);
    const cols = (header ?? []).map((h) => h.trim().toLowerCase());
    const missing = REQUIRED.filter((c) => !cols.includes(c));
    if (missing.length) throw new AppError(ErrorCode.INVALID_REQUEST, `Missing column(s): ${missing.join(', ')}. Expected: ${BULK_CSV_COLUMNS.join(', ')}`);
    if (lines.length === 0) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file has no rows');
    if (lines.length > BULK_MAX_ROWS) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${BULK_MAX_ROWS} rows per file`);

    const records = lines.map((cells) => Object.fromEntries(BULK_CSV_COLUMNS.map((c) => [c, (cols.indexOf(c) >= 0 ? cells[cols.indexOf(c)] : '')?.trim() ?? ''])));
    const orderIds = records.map((r) => r.merchant_order_id!);
    const seen = new Map<string, number>();
    const taken = new Set((await this.prisma.payout.findMany({ where: { merchantId, merchantOrderId: { in: orderIds } }, select: { merchantOrderId: true } })).map((p) => p.merchantOrderId));

    const batchId = newId('bulkBatch');
    const rows: Omit<BulkPayoutRow, 'batchId'>[] = [];
    for (const [i, rec] of records.entries()) {
      const rowNo = i + 1;
      const errors: string[] = [];
      const parsed = bulkRowSchema.safeParse(rec);
      if (!parsed.success) errors.push(...parsed.error.issues.map((e) => `${e.path.join('.') || 'row'}: ${e.message}`));
      const oid = rec.merchant_order_id ?? '';
      if (seen.has(oid)) errors.push(`merchant_order_id duplicates row ${seen.get(oid)}`);
      else seen.set(oid, rowNo);
      if (taken.has(oid)) errors.push('merchant_order_id has already been used');
      let beneficiaryId: string | null = null;
      let label: string | null = null;
      if (parsed.success && errors.length === 0) {
        const r = parsed.data;
        const { beneficiary: b } = await this.beneficiaries.upsert(this.prisma, merchantId, { name: r.beneficiary_name, type: 'INDIVIDUAL', ...(r.mode === 'UPI' ? { upi_id: r.upi_id } : { account_number: r.account_number, ifsc: r.ifsc }) }, actor.userId);
        beneficiaryId = b.id;
        label = `${b.name} · ${b.upiId ?? `${b.accountNumberMasked} (${b.ifsc})`}`;
        if (b.verificationStatus === 'BLOCKED') errors.push('Beneficiary is blocked');
        else if (b.verificationStatus === 'FAILED') errors.push('Beneficiary verification failed');
        else if (b.verificationStatus !== 'VERIFIED' && r.amount > VERIFIED_BENEFICIARY_ABOVE_MINOR) errors.push(`Verify this beneficiary before paying more than ₹${minorToMajorString(VERIFIED_BENEFICIARY_ABOVE_MINOR)}`);
      }
      rows.push({
        id: newId('bulkRow'),
        rowNo,
        merchantOrderId: oid.slice(0, 64) || null,
        amountMinor: parsed.success ? parsed.data.amount : null,
        mode: parsed.success ? parsed.data.mode : null,
        purpose: parsed.success ? parsed.data.purpose || 'SALARY' : null,
        narration: parsed.success ? parsed.data.narration || null : null,
        beneficiaryId,
        beneficiaryLabel: label,
        status: errors.length ? 'INVALID' : 'VALID',
        errors: errors.length ? errors : null,
        payoutId: null,
      });
    }
    const valid = rows.filter((r) => r.status === 'VALID');
    const total = valid.reduce((s, r) => s + (r.amountMinor ?? 0n), 0n);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.bulkPayoutBatch.create({
          data: { id: batchId, merchantId, fileName: file.originalname.slice(0, 200), fileHash, status: valid.length === rows.length ? 'VALIDATED' : 'VALIDATION_FAILED', totalRows: rows.length, validRows: valid.length, totalAmountMinor: total, createdById: actor.userId },
        });
        await tx.bulkPayoutRow.createMany({ data: rows.map((r) => ({ ...r, batchId, errors: r.errors ?? undefined })) });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'This exact file was already uploaded');
      throw err;
    }
    await this.audit.record({ action: 'payout.bulk.uploaded', resourceType: 'bulk_payout_batch', resourceId: batchId, organizationId: merchantId, metadata: { rows: rows.length, valid: valid.length, total: minorToMajorString(total) } });
    return this.get(actor, batchId);
  }

  async get(actor: Actor, id: string) {
    const b = await this.requireBatch(actor, id);
    const rows = await this.prisma.bulkPayoutRow.findMany({ where: { batchId: id }, orderBy: { rowNo: 'asc' } });
    return presentBatch(b, rows);
  }

  async list(actor: Actor) {
    const where = actor.organizationType === 'MERCHANT' ? { merchantId: actor.organizationId } : {};
    const batches = await this.prisma.bulkPayoutBatch.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
    return batches.map((b) => presentBatch(b));
  }

  /** Maker confirms a fully valid batch; rows are then created by the jobs process. */
  async confirm(actor: Actor, id: string) {
    const b = await this.requireBatch(actor, id);
    if (b.status !== 'VALIDATED') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, b.status === 'VALIDATION_FAILED' ? 'Fix the invalid rows and upload the file again' : `Batch is ${b.status.toLowerCase()}`);
    const s = await this.prisma.session.findUnique({ where: { id: actor.sessionId }, select: { mfaVerifiedAt: true } });
    if (!s?.mfaVerifiedAt) throw new AppError(ErrorCode.MFA_ENROLLMENT_REQUIRED, 'Confirming a bulk payout needs two-factor authentication. Set it up under Settings → Security, then sign in again.');
    const batchApprovals = await this.limits.approvalsRequiredFor(b.merchantId, b.totalAmountMinor, 'PAYOUT');
    const res = await this.prisma.bulkPayoutBatch.updateMany({ where: { id, status: 'VALIDATED', version: b.version }, data: { status: 'CONFIRMED', batchApprovals, confirmedById: actor.userId, confirmedAt: new Date(), version: { increment: 1 } } });
    if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Batch changed concurrently');
    await this.audit.record({ action: 'payout.bulk.confirmed', resourceType: 'bulk_payout_batch', resourceId: id, organizationId: b.merchantId, metadata: { rows: b.validRows, total: minorToMajorString(b.totalAmountMinor), approvals_required: batchApprovals } });
    return this.get(actor, id);
  }

  async cancel(actor: Actor, id: string) {
    const b = await this.requireBatch(actor, id);
    const res = await this.prisma.bulkPayoutBatch.updateMany({ where: { id, status: { in: ['VALIDATED', 'VALIDATION_FAILED'] } }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `A ${b.status.toLowerCase()} batch cannot be cancelled`);
    return this.get(actor, id);
  }

  /** Approve (or reject) every payout of the batch this checker can still vote on. */
  async decideAll(actor: Actor, id: string, decision: 'APPROVE' | 'REJECT', reason?: string) {
    await this.requireBatch(actor, id);
    const pending = await this.prisma.payout.findMany({
      where: { bulkBatchId: id, status: 'APPROVAL_PENDING', NOT: { createdById: actor.userId }, approvals: { none: { approverId: actor.userId } } },
      select: { id: true },
      orderBy: { bulkRowNo: 'asc' },
    });
    let done = 0;
    const failed: { payout_id: string; error: string }[] = [];
    for (const p of pending) {
      try {
        if (decision === 'APPROVE') await this.payouts.approve(actor, p.id, reason);
        else await this.payouts.reject(actor, p.id, reason ?? 'Batch rejected');
        done++;
      } catch (err) {
        failed.push({ payout_id: p.id, error: err instanceof Error ? err.message : 'failed' });
      }
    }
    return { decided: done, failed };
  }

  /** Jobs: create payouts for confirmed batches, a slice per tick. Stops on insufficient balance. */
  async processConfirmed(): Promise<number> {
    const batch = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM bulk_payout_batches WHERE status IN ('CONFIRMED', 'PROCESSING') ORDER BY confirmed_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return null;
      return tx.bulkPayoutBatch.update({ where: { id: rows[0].id }, data: { status: 'PROCESSING' } });
    });
    if (!batch) return 0;
    const confirmer = await this.prisma.user.findUniqueOrThrow({ where: { id: batch.confirmedById! } });
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: batch.merchantId } });
    // The confirmer is the maker of every row (so they can't approve them).
    const actor: Actor = { kind: 'user', userId: confirmer.id, sessionId: 'bulk-processor', organizationId: org.id, organizationType: 'MERCHANT', organizationParentId: org.parentId, roleKeys: [], permissions: new Set(), restricted: false };
    const rows = await this.prisma.bulkPayoutRow.findMany({ where: { batchId: batch.id, status: 'VALID' }, orderBy: { rowNo: 'asc' }, take: ROWS_PER_TICK });
    let created = 0;
    let failed = 0;
    let stop = false;
    for (const r of rows) {
      if (stop) {
        await this.prisma.bulkPayoutRow.update({ where: { id: r.id }, data: { status: 'FAILED', errors: ['Not processed: an earlier row hit insufficient balance'] } });
        failed++;
        continue;
      }
      const raw = { merchant_order_id: r.merchantOrderId, amount: minorToMajorString(r.amountMinor!), mode: r.mode, purpose: r.purpose, beneficiary: { beneficiary_id: r.beneficiaryId }, ...(r.narration ? { narration: r.narration } : {}) };
      try {
        const p = await this.payouts.create(actor, createPayoutSchema.parse(raw), raw, `bulk_${batch.id}_${r.rowNo}`, { source: 'BULK', bulk: { batchId: batch.id, rowNo: r.rowNo, approvalsFloor: batch.batchApprovals } });
        await this.prisma.bulkPayoutRow.update({ where: { id: r.id }, data: { status: 'CREATED', payoutId: p.payout_id } });
        created++;
      } catch (err) {
        const message = err instanceof AppError ? err.message : 'Unexpected error';
        await this.prisma.bulkPayoutRow.update({ where: { id: r.id }, data: { status: 'FAILED', errors: [message] } });
        failed++;
        if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_BALANCE) stop = true;
        if (!(err instanceof AppError)) this.logger.error({ err, batchId: batch.id, rowNo: r.rowNo }, 'Bulk row failed unexpectedly');
      }
    }
    if (stop) await this.prisma.bulkPayoutRow.updateMany({ where: { batchId: batch.id, status: 'VALID' }, data: { status: 'FAILED', errors: ['Not processed: an earlier row hit insufficient balance'] } });
    const remaining = await this.prisma.bulkPayoutRow.count({ where: { batchId: batch.id, status: 'VALID' } });
    const failedTotal = await this.prisma.bulkPayoutRow.count({ where: { batchId: batch.id, status: 'FAILED' } });
    await this.prisma.bulkPayoutBatch.update({
      where: { id: batch.id },
      data: { createdCount: { increment: created }, failedCount: failedTotal, ...(remaining === 0 ? { status: 'COMPLETED', completedAt: new Date() } : {}) },
    });
    return created + failed;
  }
}
