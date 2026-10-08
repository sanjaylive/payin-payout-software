import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { type CollectionAccount, type FundRequest, isUniqueViolation, notifyInbox, platformOrganizationId, type Prisma, type PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import type { collectionAccountSchema, createFundRequestSchema, decideFundRequestSchema, listFundRequestsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { inspectImage } from '../brand/image-inspect';
import { LedgerService } from '../ledger/ledger.service';

type AccountInput = z.output<typeof collectionAccountSchema>;
type RequestRow = FundRequest & { collectionAccount: CollectionAccount };

const PROOF_MAX = 5 * 1024 * 1024;
const MAX_OPEN_PER_MERCHANT = 20;
const aad = (id: string) => `collection-account:${id}`;
const rupees = (m: bigint) => `₹${Number(minorToMajorString(m)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Ledger account for money received in a collection account (an ASSET, one per account). */
export const collectionLedgerCode = (accountId: string) => Accounts.bank(accountId.toLowerCase());

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

/**
 * Wallet top-ups (docs/FUND_REQUESTS.md): super admins publish collection accounts (bank / UPI);
 * a merchant pays into one, submits the UTR, and an approver credits its AVAILABLE balance with a
 * FUND_LOAD journal. A UTR can be claimed once while pending or approved.
 */
@Injectable()
export class FundsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly ledger: LedgerService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ---- Collection accounts ----------------------------------------------------------------------

  private presentAccount(a: CollectionAccount, opts: { fullNumber?: boolean; usage?: { pending: number; approved_minor: bigint } } = {}) {
    return {
      id: a.id,
      kind: a.kind,
      label: a.label,
      account_holder: a.accountHolder,
      account_number: opts.fullNumber && a.accountNumberEncrypted ? this.encryptor.decrypt(a.accountNumberEncrypted, aad(a.id)) : undefined,
      account_number_masked: a.accountNumberLast4 ? `XXXXXX${a.accountNumberLast4}` : null,
      ifsc: a.ifsc,
      bank_name: a.bankName,
      branch: a.branch,
      account_type: a.accountType,
      upi_id: a.upiId,
      payee_name: a.payeeName,
      min_amount: a.minAmountMinor === null ? null : minorToMajorString(a.minAmountMinor),
      max_amount: a.maxAmountMinor === null ? null : minorToMajorString(a.maxAmountMinor),
      instructions: a.instructions,
      is_active: a.isActive,
      sort_order: a.sortOrder,
      version: a.version,
      ...(opts.usage ? { pending_requests: opts.usage.pending, approved_total: minorToMajorString(opts.usage.approved_minor) } : {}),
      updated_at: a.updatedAt,
    };
  }

  async listAccounts(actor: Actor) {
    platformOnly(actor);
    const [rows, pending, approved] = await Promise.all([
      this.prisma.collectionAccount.findMany({ orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.fundRequest.groupBy({ by: ['collectionAccountId'], where: { status: 'PENDING' }, _count: true }),
      this.prisma.fundRequest.groupBy({ by: ['collectionAccountId'], where: { status: 'APPROVED' }, _sum: { creditedAmountMinor: true } }),
    ]);
    return rows.map((a) =>
      this.presentAccount(a, {
        usage: { pending: pending.find((p) => p.collectionAccountId === a.id)?._count ?? 0, approved_minor: approved.find((p) => p.collectionAccountId === a.id)?._sum.creditedAmountMinor ?? 0n },
      }),
    );
  }

  /** What a merchant may pay into: active accounts, with the full account number. */
  async accountsForMerchant(actor: Actor) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN);
    const rows = await this.prisma.collectionAccount.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map((a) => this.presentAccount(a, { fullNumber: true }));
  }

  private accountData(input: AccountInput) {
    const common = {
      kind: input.kind,
      label: input.label,
      minAmountMinor: input.min_amount,
      maxAmountMinor: input.max_amount,
      instructions: input.instructions,
      isActive: input.is_active,
      sortOrder: input.sort_order,
    };
    return input.kind === 'BANK'
      ? { ...common, accountHolder: input.account_holder, ifsc: input.ifsc, bankName: input.bank_name, branch: input.branch, accountType: input.account_type, upiId: null, payeeName: null }
      : { ...common, upiId: input.upi_id, payeeName: input.payee_name, accountHolder: null, ifsc: null, bankName: null, branch: null, accountType: null, accountNumberEncrypted: null, accountNumberLast4: null };
  }

  async createAccount(actor: Actor, input: AccountInput) {
    platformOnly(actor);
    if (input.kind === 'BANK' && !input.account_number) throw new AppError(ErrorCode.INVALID_REQUEST, 'Enter the account number', [{ path: 'account_number', message: 'Required' }]);
    const id = newId('collectionAccount');
    const created = await this.prisma.$transaction(async (tx) => {
      const a = await tx.collectionAccount.create({
        data: {
          id,
          ...this.accountData(input),
          ...(input.kind === 'BANK' ? { accountNumberEncrypted: this.encryptor.encrypt(input.account_number!, aad(id)), accountNumberLast4: input.account_number!.slice(-4) } : {}),
          createdById: actor.userId,
        },
      });
      await this.audit.record({ action: 'funds.account.created', resourceType: 'collection_account', resourceId: id, organizationId: null, newValue: this.presentAccount(a), metadata: { reason: input.reason } }, tx);
      return a;
    });
    return this.presentAccount(created);
  }

  async updateAccount(actor: Actor, id: string, input: AccountInput & { version?: number }) {
    platformOnly(actor);
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.collectionAccount.findUnique({ where: { id } });
      if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Account not found');
      if (before.kind !== input.kind) throw new AppError(ErrorCode.INVALID_REQUEST, 'An account can’t change between bank and UPI; add a new one instead');
      const number = input.kind === 'BANK' && input.account_number ? { accountNumberEncrypted: this.encryptor.encrypt(input.account_number, aad(id)), accountNumberLast4: input.account_number.slice(-4) } : {};
      // The money already received sits in this account's ledger: its identity can't change under it.
      if (Object.keys(number).length && (await tx.fundRequest.count({ where: { collectionAccountId: id, status: { in: ['PENDING', 'APPROVED'] } } }))) {
        if (this.encryptor.decrypt(before.accountNumberEncrypted!, aad(id)) !== (input as { account_number: string }).account_number) {
          throw new AppError(ErrorCode.CONFLICT, 'This account already has fund requests; add the new bank account separately and switch this one off', [{ path: 'account_number', message: 'Locked' }]);
        }
      }
      const n = await tx.collectionAccount.updateMany({ where: { id, version: before.version }, data: { ...this.accountData(input), ...number, version: { increment: 1 } } });
      if (n.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Someone else changed this account; reload and try again');
      const after = await tx.collectionAccount.findUniqueOrThrow({ where: { id } });
      await this.audit.record({ action: 'funds.account.updated', resourceType: 'collection_account', resourceId: id, organizationId: null, oldValue: this.presentAccount(before), newValue: this.presentAccount(after), metadata: { reason: input.reason, account_number_changed: Object.keys(number).length > 0 } }, tx);
      return after;
    });
    return this.presentAccount(updated);
  }

  async removeAccount(actor: Actor, id: string, reason: string) {
    platformOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const a = await tx.collectionAccount.findUnique({ where: { id } });
      if (!a) throw new AppError(ErrorCode.NOT_FOUND, 'Account not found');
      if (await tx.fundRequest.count({ where: { collectionAccountId: id } })) throw new AppError(ErrorCode.CONFLICT, 'This account has fund requests; switch it off instead');
      await tx.collectionAccount.delete({ where: { id } });
      await this.audit.record({ action: 'funds.account.removed', resourceType: 'collection_account', resourceId: id, organizationId: null, oldValue: this.presentAccount(a), metadata: { reason } }, tx);
    });
    return { removed: true };
  }

  // ---- Fund requests ----------------------------------------------------------------------------

  private presentRequest(r: RequestRow, merchantName?: string) {
    return {
      id: r.id,
      merchant_id: r.merchantId,
      merchant_name: merchantName,
      amount: minorToMajorString(r.amountMinor),
      credited_amount: r.creditedAmountMinor === null ? null : minorToMajorString(r.creditedAmountMinor),
      mode: r.mode,
      utr: r.utr,
      paid_at: r.paidAt,
      remarks: r.remarks,
      has_proof: !!r.proofKey,
      proof_name: r.proofName,
      status: r.status,
      decision_note: r.decisionNote,
      decided_at: r.decidedAt,
      journal_id: r.journalId,
      account: { id: r.collectionAccount.id, kind: r.collectionAccount.kind, label: r.collectionAccount.label, upi_id: r.collectionAccount.upiId, account_number_masked: r.collectionAccount.accountNumberLast4 ? `XXXXXX${r.collectionAccount.accountNumberLast4}` : null },
      created_at: r.createdAt,
    };
  }

  async create(actor: Actor, input: z.output<typeof createFundRequestSchema>) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Fund requests are made by merchants');
    const merchantId = actor.organizationId;
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { status: true, organization: { select: { name: true } } } });
    if (merchant.status !== 'APPROVED') throw new AppError(ErrorCode.MERCHANT_INACTIVE, 'Your account must be approved before you can add funds');
    const account = await this.prisma.collectionAccount.findUnique({ where: { id: input.collection_account_id } });
    if (!account || !account.isActive) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose an available payment account', [{ path: 'collection_account_id', message: 'Not available' }]);
    if (account.minAmountMinor !== null && input.amount < account.minAmountMinor) throw new AppError(ErrorCode.INVALID_REQUEST, `The minimum for this account is ${rupees(account.minAmountMinor)}`, [{ path: 'amount', message: 'Too small' }]);
    if (account.maxAmountMinor !== null && input.amount > account.maxAmountMinor) throw new AppError(ErrorCode.INVALID_REQUEST, `The maximum for this account is ${rupees(account.maxAmountMinor)}`, [{ path: 'amount', message: 'Too large' }]);
    if (account.kind === 'UPI' && input.mode !== 'UPI') throw new AppError(ErrorCode.INVALID_REQUEST, 'Payments to a UPI ID are made by UPI', [{ path: 'mode', message: 'Use UPI' }]);
    const paidAt = new Date(input.paid_at);
    if (paidAt.getTime() > Date.now() + 5 * 60_000) throw new AppError(ErrorCode.INVALID_REQUEST, 'The payment time can’t be in the future', [{ path: 'paid_at', message: 'In the future' }]);
    if (paidAt.getTime() < Date.now() - 30 * 86_400_000) throw new AppError(ErrorCode.INVALID_REQUEST, 'Payments older than 30 days need support’s help', [{ path: 'paid_at', message: 'Too old' }]);
    if ((await this.prisma.fundRequest.count({ where: { merchantId, status: 'PENDING' } })) >= MAX_OPEN_PER_MERCHANT) {
      throw new AppError(ErrorCode.RATE_LIMITED, `You have ${MAX_OPEN_PER_MERCHANT} requests waiting; wait for them to be reviewed`);
    }
    // A UTR is claimable once, for ever (unique index). Say so before inserting; tell a merchant about
    // its own earlier claim, but reveal nothing about another merchant's.
    const earlier = await this.prisma.fundRequest.findUnique({ where: { utr: input.utr }, select: { merchantId: true, status: true, createdAt: true } });
    if (earlier) throw this.duplicateUtr(input.utr, earlier.merchantId === merchantId ? earlier : null);
    const id = newId('fundRequest');
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const r = await tx.fundRequest.create({
          data: { id, merchantId, collectionAccountId: account.id, amountMinor: input.amount, mode: input.mode, utr: input.utr, paidAt, remarks: input.remarks, createdById: actor.userId },
          include: { collectionAccount: true },
        });
        await this.audit.record({ action: 'funds.request.created', resourceType: 'fund_request', resourceId: id, organizationId: merchantId, newValue: { amount: minorToMajorString(r.amountMinor), mode: r.mode, utr: r.utr, account: account.label } }, tx);
        const platform = await platformOrganizationId(tx);
        if (platform) {
          await notifyInbox(tx, {
            organizationId: platform,
            audience: { permission: 'fund.approve' },
            category: 'WALLET',
            severity: 'WARNING',
            title: `Fund request of ${rupees(r.amountMinor)} to review`,
            body: `${merchant.organization.name} · ${r.mode} · UTR ${r.utr} · ${account.label}`,
            link: `/admin/funds?request=${id}`,
            resourceType: 'fund_request',
            resourceId: id,
            dedupeKey: `fund_request:${id}:created`,
          });
        }
        return r;
      });
      return this.presentRequest(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicateUtr(input.utr, null);
      throw err;
    }
  }

  private duplicateUtr(utr: string, own: { status: string; createdAt: Date } | null) {
    const when = own ? ` on ${own.createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })} (${own.status.toLowerCase()})` : '';
    return new AppError(ErrorCode.CONFLICT, `UTR ${utr} has already been submitted${when}. Each UTR can be used only once.`, [{ path: 'utr', message: 'Already used' }]);
  }

  private async load(actor: Actor, id: string): Promise<RequestRow> {
    const r = await this.prisma.fundRequest.findUnique({ where: { id }, include: { collectionAccount: true } });
    // Merchants see only their own; nothing else (not even existence).
    if (!r || (actor.organizationType !== 'PLATFORM' && r.merchantId !== actor.organizationId)) throw new AppError(ErrorCode.NOT_FOUND, 'Fund request not found');
    if (actor.organizationType !== 'PLATFORM' && actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.NOT_FOUND, 'Fund request not found');
    return r;
  }

  async get(actor: Actor, id: string) {
    const r = await this.load(actor, id);
    const name = actor.organizationType === 'PLATFORM' ? (await this.prisma.organization.findUnique({ where: { id: r.merchantId }, select: { name: true } }))?.name : undefined;
    return this.presentRequest(r, name);
  }

  async list(actor: Actor, q: z.output<typeof listFundRequestsQuerySchema>) {
    if (actor.organizationType !== 'PLATFORM' && actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN);
    const scope: Prisma.FundRequestWhereInput = actor.organizationType === 'MERCHANT' ? { merchantId: actor.organizationId } : q.merchant_id ? { merchantId: q.merchant_id } : {};
    const search: Prisma.FundRequestWhereInput = q.q ? { OR: [{ utr: { contains: q.q.toUpperCase().replace(/[\s-]/g, '') } }, { id: q.q }] } : {};
    const rows = await this.prisma.fundRequest.findMany({
      where: { AND: [scope, search, q.status ? { status: q.status } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { collectionAccount: true },
    });
    const names = actor.organizationType === 'PLATFORM' ? new Map((await this.prisma.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.merchantId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name])) : null;
    return toPage(rows, q.limit, (r) => this.presentRequest(r, names?.get(r.merchantId)));
  }

  /** Counts for the queue header (platform) or the wallet page (merchant). */
  async summary(actor: Actor) {
    const scope: Prisma.FundRequestWhereInput = actor.organizationType === 'MERCHANT' ? { merchantId: actor.organizationId } : actor.organizationType === 'PLATFORM' ? {} : { id: '__none__' };
    // Midnight in India (UTC+05:30, no DST).
    const ist = new Date(Date.now() + 330 * 60_000);
    const startOfDay = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
    const [pending, today] = await Promise.all([
      this.prisma.fundRequest.aggregate({ where: { ...scope, status: 'PENDING' }, _count: true, _sum: { amountMinor: true } }),
      this.prisma.fundRequest.aggregate({ where: { ...scope, status: 'APPROVED', decidedAt: { gte: startOfDay } }, _count: true, _sum: { creditedAmountMinor: true } }),
    ]);
    return { pending_count: pending._count, pending_amount: minorToMajorString(pending._sum.amountMinor ?? 0n), approved_today_count: today._count, approved_today_amount: minorToMajorString(today._sum.creditedAmountMinor ?? 0n) };
  }

  async uploadProof(actor: Actor, id: string, file: { buffer: Buffer; size: number; originalname: string } | undefined) {
    const r = await this.load(actor, id);
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN);
    if (r.status !== 'PENDING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Proof can be added only while the request is pending');
    if (!file || file.size === 0) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose a screenshot or PDF');
    if (file.size > PROOF_MAX) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file can be at most 5 MB');
    let type: string;
    if (file.buffer.subarray(0, 5).toString('ascii') === '%PDF-') type = 'application/pdf';
    else {
      try {
        type = inspectImage(file.buffer).type;
      } catch {
        type = '';
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new AppError(ErrorCode.INVALID_REQUEST, 'Upload a PNG, JPEG, WebP screenshot or a PDF');
    }
    const key = `fund-requests/${r.merchantId}/${id}/proof-${Date.now()}`;
    await this.storage.put(key, file.buffer, type, createHash('sha256').update(file.buffer).digest('hex'));
    const name = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 160) || 'proof';
    const n = await this.prisma.fundRequest.updateMany({ where: { id, status: 'PENDING', version: r.version }, data: { proofKey: key, proofName: name, proofType: type, version: { increment: 1 } } });
    if (n.count !== 1) {
      await this.storage.delete(key);
      throw new AppError(ErrorCode.CONFLICT, 'The request changed; reload and try again');
    }
    if (r.proofKey) await this.storage.delete(r.proofKey).catch(() => undefined);
    return this.get(actor, id);
  }

  async proof(actor: Actor, id: string): Promise<{ stream: Readable; type: string; name: string }> {
    const r = await this.load(actor, id);
    if (!r.proofKey) throw new AppError(ErrorCode.NOT_FOUND, 'No proof was attached');
    await this.audit.record({ action: 'funds.request.proof_viewed', resourceType: 'fund_request', resourceId: id, organizationId: r.merchantId });
    return { stream: await this.storage.getStream(r.proofKey), type: r.proofType ?? 'application/octet-stream', name: r.proofName ?? 'proof' };
  }

  async cancel(actor: Actor, id: string) {
    const r = await this.load(actor, id);
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN);
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.fundRequest.updateMany({ where: { id, status: 'PENDING', version: r.version }, data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: actor.userId, version: { increment: 1 } } });
      if (n.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only pending requests can be cancelled');
      await this.audit.record({ action: 'funds.request.cancelled', resourceType: 'fund_request', resourceId: id, organizationId: r.merchantId }, tx);
    });
    return this.get(actor, id);
  }

  async decide(actor: Actor, id: string, input: z.output<typeof decideFundRequestSchema>) {
    platformOnly(actor);
    const r = await this.load(actor, id);
    if (r.status !== 'PENDING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `This request is already ${r.status.toLowerCase()}`);
    const notify = (tx: Prisma.TransactionClient, title: string, body: string, severity: 'SUCCESS' | 'WARNING') =>
      notifyInbox(tx, { organizationId: r.merchantId, audience: { permission: 'fund.read' }, category: 'WALLET', severity, title, body, link: '/accounts/add-funds', resourceType: 'fund_request', resourceId: id, dedupeKey: `fund_request:${id}:decided` });

    if (input.decision === 'REJECT') {
      await this.prisma.$transaction(async (tx) => {
        const n = await tx.fundRequest.updateMany({ where: { id, status: 'PENDING', version: r.version }, data: { status: 'REJECTED', decidedAt: new Date(), decidedById: actor.userId, decisionNote: input.note, version: { increment: 1 } } });
        if (n.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'The request changed; reload and try again');
        await this.audit.record({ action: 'funds.request.rejected', resourceType: 'fund_request', resourceId: id, organizationId: r.merchantId, metadata: { note: input.note } }, tx);
        await notify(tx, `Fund request of ${rupees(r.amountMinor)} was rejected`, `UTR ${r.utr} · ${input.note}`, 'WARNING');
      });
      return this.get(actor, id);
    }

    const credited = input.credited_amount ?? r.amountMinor;
    // The UTR can never be resubmitted, so a wrong amount on the claim is corrected here, up or down,
    // to what the statement shows, with a note.
    if (credited !== r.amountMinor && !input.note?.trim()) throw new AppError(ErrorCode.INVALID_REQUEST, 'Explain why the credited amount differs from the request', [{ path: 'note', message: 'Required when the amount changes' }]);
    await this.ledger.run(async (tx) => {
      const merchant = await tx.merchant.findUnique({ where: { id: r.merchantId }, select: { status: true } });
      if (!merchant || !['APPROVED', 'SUSPENDED'].includes(merchant.status)) throw new AppError(ErrorCode.MERCHANT_INACTIVE, 'Funds can be loaded only for approved (or suspended) merchants');
      // Claim the request first: a concurrent approve or reject loses here, before any posting.
      const n = await tx.fundRequest.updateMany({ where: { id, status: 'PENDING', version: r.version }, data: { version: { increment: 1 } } });
      if (n.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'The request changed; reload and try again');
      const posted = await this.ledger.post(tx, {
        type: 'FUND_LOAD',
        idempotencyKey: `fund_request:${id}:load`,
        source: { type: 'FUND_REQUEST', id },
        description: `Wallet top-up ${r.utr}`,
        metadata: { utr: r.utr, mode: r.mode, collection_account_id: r.collectionAccountId, approved_by: actor.userId },
        lines: [
          { accountCode: collectionLedgerCode(r.collectionAccountId), direction: 'DEBIT', amountMinor: credited, currency: 'INR' },
          { accountCode: Accounts.merchant(r.merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: credited, currency: 'INR' },
        ],
      });
      await tx.fundRequest.update({ where: { id }, data: { status: 'APPROVED', creditedAmountMinor: credited, journalId: posted.journalId, decidedAt: new Date(), decidedById: actor.userId, decisionNote: input.note ?? null } });
      await this.audit.record({ action: 'funds.request.approved', resourceType: 'fund_request', resourceId: id, organizationId: r.merchantId, newValue: { credited: minorToMajorString(credited), journal_id: posted.journalId }, metadata: { note: input.note, severity: 'HIGH' } }, tx);
      await notify(tx, `${rupees(credited)} added to your wallet`, `Fund request UTR ${r.utr} was approved${credited !== r.amountMinor ? ` for ${rupees(credited)} (requested ${rupees(r.amountMinor)})` : ''}.`, 'SUCCESS');
    });
    return this.get(actor, id);
  }
}
