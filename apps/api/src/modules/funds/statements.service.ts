import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type PrismaClient, type StatementLine } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import { parseBankStatement, StatementFormatError } from '@pay2all/validation';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { FundsService } from './funds.service';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Bank statement matching (docs/FUND_REQUESTS.md §6). An approver uploads the collection account's
 * statement; each credit is matched to a pending fund request with the same UTR, on the same
 * account, for exactly the same amount, and that request is approved. Everything else is listed for
 * review. Statement lines are append-only evidence; one UTR backs at most one request.
 */
@Injectable()
export class StatementsService {
  private readonly logger = new Logger(StatementsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly funds: FundsService,
    private readonly audit: AuditService,
  ) {}

  private presentLine(l: StatementLine, request?: { id: string; merchantName: string; amountMinor: bigint; status: string } | null) {
    return {
      id: l.id,
      line_no: l.lineNo,
      value_date: l.valueDate,
      description: l.description,
      amount: minorToMajorString(l.amountMinor),
      utr: l.utr,
      status: l.status,
      fund_request: request ? { id: request.id, merchant_name: request.merchantName, amount: minorToMajorString(request.amountMinor), status: request.status } : null,
      matched_at: l.matchedAt,
    };
  }

  async import(actor: Actor, collectionAccountId: string, file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    if (!file) throw new AppError(ErrorCode.INVALID_REQUEST, 'Attach the statement as a CSV file');
    if (file.size > MAX_BYTES) throw new AppError(ErrorCode.INVALID_REQUEST, 'The file is larger than 5 MB');
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw new AppError(ErrorCode.INVALID_REQUEST, 'Upload the statement as CSV (export it from your bank as CSV, not PDF or Excel)');
    const account = await this.prisma.collectionAccount.findUnique({ where: { id: collectionAccountId } });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND, 'Collection account not found');

    let parsed;
    try {
      parsed = parseBankStatement(text);
    } catch (err) {
      if (err instanceof StatementFormatError) throw new AppError(ErrorCode.INVALID_REQUEST, err.message);
      throw err;
    }
    if (!parsed.credits.length) throw new AppError(ErrorCode.INVALID_REQUEST, 'No credits found in this statement');

    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const importId = newId('statementImport');
    try {
      await this.prisma.statementImport.create({
        data: { id: importId, collectionAccountId, fileName: file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 160), fileSha256: sha, credits: parsed.credits.length, matched: 0, mismatched: 0, unmatched: 0, alreadyDecided: 0, duplicates: 0, uploadedById: actor.userId },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'This statement file has already been imported for this account');
      throw err;
    }

    const counts = { matched: 0, mismatched: 0, unmatched: 0, alreadyDecided: 0, duplicates: 0 };
    for (const c of parsed.credits) {
      const requests = c.references.length ? await this.prisma.fundRequest.findMany({ where: { collectionAccountId, utr: { in: c.references } }, include: { collectionAccount: true } }) : [];
      const request = requests[0];
      const utr = request?.utr ?? c.references[0] ?? null;
      const status = !request ? 'UNMATCHED' : request.status !== 'PENDING' ? 'ALREADY_DECIDED' : request.amountMinor !== c.amountMinor ? 'AMOUNT_MISMATCH' : 'UNMATCHED';
      let line: StatementLine;
      try {
        line = await this.prisma.statementLine.create({
          data: { id: newId('statementLine'), importId, collectionAccountId, lineNo: c.lineNo, valueDate: c.valueDate, description: c.description, amountMinor: c.amountMinor, utr, references: c.references, status },
        });
      } catch (err) {
        // The same credit from an overlapping statement: already recorded under this UTR.
        if (isUniqueViolation(err)) {
          counts.duplicates++;
          continue;
        }
        throw err;
      }
      if (request && status === 'UNMATCHED') {
        try {
          await this.funds.approve(request, c.amountMinor, { userId: actor.userId, note: `Matched to bank statement ${file.originalname.slice(0, 80)} (line ${c.lineNo})`, statementLineId: line.id });
          counts.matched++;
        } catch (err) {
          // Decided concurrently, or the merchant can't be credited: leave the line for review.
          this.logger.warn({ err: (err as Error).message, requestId: request.id }, 'Statement match could not approve the request');
          counts.unmatched++;
        }
      } else if (status === 'AMOUNT_MISMATCH') counts.mismatched++;
      else if (status === 'ALREADY_DECIDED') counts.alreadyDecided++;
      else counts.unmatched++;
    }
    await this.prisma.statementImport.update({ where: { id: importId }, data: counts });
    await this.audit.record({ action: 'funds.statement.imported', resourceType: 'statement_import', resourceId: importId, organizationId: null, metadata: { account: account.label, credits: parsed.credits.length, ...counts, debits: parsed.debits, columns: parsed.columns, severity: counts.matched ? 'HIGH' : 'LOW' } });
    return this.get(actor, importId);
  }

  async list(actor: Actor) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const rows = await this.prisma.statementImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { collectionAccount: { select: { label: true } } } });
    return rows.map((i) => ({ id: i.id, account: i.collectionAccount.label, file_name: i.fileName, credits: i.credits, matched: i.matched, mismatched: i.mismatched, unmatched: i.unmatched, already_decided: i.alreadyDecided, duplicates: i.duplicates, created_at: i.createdAt }));
  }

  async get(actor: Actor, id: string) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const i = await this.prisma.statementImport.findUnique({ where: { id }, include: { collectionAccount: { select: { label: true } } } });
    if (!i) throw new AppError(ErrorCode.NOT_FOUND, 'Import not found');
    const lines = await this.prisma.statementLine.findMany({ where: { importId: id }, orderBy: { lineNo: 'asc' } });
    const utrs = lines.flatMap((l) => (l.utr ? [l.utr] : []));
    const requests = utrs.length ? await this.prisma.fundRequest.findMany({ where: { utr: { in: utrs }, collectionAccountId: i.collectionAccountId }, select: { id: true, utr: true, amountMinor: true, status: true, merchantId: true } }) : [];
    const names = new Map((await this.prisma.organization.findMany({ where: { id: { in: [...new Set(requests.map((r) => r.merchantId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const byUtr = new Map(requests.map((r) => [r.utr, { id: r.id, merchantName: names.get(r.merchantId) ?? r.merchantId, amountMinor: r.amountMinor, status: r.status }]));
    return {
      id: i.id,
      account: i.collectionAccount.label,
      file_name: i.fileName,
      created_at: i.createdAt,
      summary: { credits: i.credits, matched: i.matched, mismatched: i.mismatched, unmatched: i.unmatched, already_decided: i.alreadyDecided, duplicates: i.duplicates },
      lines: lines.map((l) => this.presentLine(l, l.utr ? byUtr.get(l.utr) : null)),
    };
  }
}
