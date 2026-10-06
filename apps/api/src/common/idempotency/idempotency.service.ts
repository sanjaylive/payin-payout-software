import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type DbClient, isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { type ApiFailure, type ApiSuccess, ErrorCode } from '@pay2all/types';
import { idempotencyKeySchema } from '@pay2all/validation';
import { RequestContextStore } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { PRISMA } from '../../infra/tokens';

/** Thrown to short-circuit a request with a stored response (handled by AllExceptionsFilter). */
export class ReplayedResponse extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('Idempotent replay');
    this.name = 'ReplayedResponse';
  }
}

/** Canonical JSON: sorted keys, no whitespace, bigint as string — stable across key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(typeof value === 'bigint' ? value.toString() : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const TTL_MS = 24 * 3600 * 1000;
/** Business errors that will deterministically repeat — safe (and expected) to replay. */
const REPLAYABLE_ERRORS = new Set<string>([
  ErrorCode.MERCHANT_INACTIVE,
  ErrorCode.KYC_NOT_APPROVED,
  ErrorCode.PAYIN_DISABLED,
  ErrorCode.PAYOUT_DISABLED,
  ErrorCode.LIMIT_EXCEEDED,
  ErrorCode.DUPLICATE_ORDER,
  ErrorCode.RISK_BLOCKED,
  ErrorCode.REFUND_NOT_ALLOWED,
  ErrorCode.INSUFFICIENT_BALANCE,
  ErrorCode.TRANSACTION_NOT_FOUND,
  ErrorCode.INVALID_REQUEST,
]);

export interface IdempotentResult<T> {
  status: number;
  data: T;
  resourceId?: string;
}

/**
 * Request-level idempotency (docs/PAYIN_FLOW.md §4). One key per merchant produces exactly one
 * outcome: the first request runs; repeats get the identical stored response; a different payload
 * with the same key is a conflict; a repeat while the first is still running is told to retry.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  hash(method: string, path: string, body: unknown): string {
    return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`).digest('hex');
  }

  async run<T>(
    scope: { merchantId: string; key: string | undefined; method: string; path: string; body: unknown },
    work: (recordId: string) => Promise<IdempotentResult<T>>,
  ): Promise<T> {
    const parsed = idempotencyKeySchema.safeParse(scope.key);
    if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST, 'An Idempotency-Key header is required (1–64 characters [A-Za-z0-9_-])');
    const key = parsed.data;
    const requestHash = this.hash(scope.method, scope.path, scope.body);
    const recordId = newId('idempotency');

    try {
      await this.prisma.idempotencyRecord.create({
        data: { id: recordId, merchantId: scope.merchantId, idempotencyKey: key, requestMethod: scope.method, requestPath: scope.path.slice(0, 200), requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { merchantId_idempotencyKey: { merchantId: scope.merchantId, idempotencyKey: key } } });
      if (!existing) throw new AppError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Request in progress; retry shortly');
      if (existing.requestHash !== requestHash) throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT);
      if (existing.status === 'COMPLETED' && existing.responseStatusCode) throw new ReplayedResponse(existing.responseStatusCode, existing.responseBody);
      throw new AppError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'The original request is still being processed; retry shortly');
    }

    try {
      const result = await work(recordId);
      const envelope: ApiSuccess<T> = { success: true, data: result.data };
      await this.complete(this.prisma, recordId, result.status, envelope, result.resourceId);
      return result.data;
    } catch (err) {
      if (err instanceof AppError && err.status < 500 && REPLAYABLE_ERRORS.has(err.code)) {
        const body: ApiFailure = { success: false, error: { code: err.code, message: err.message, request_id: RequestContextStore.get()?.requestId ?? 'unknown', ...(err.details?.length ? { details: err.details } : {}) } };
        await this.complete(this.prisma, recordId, err.status, body);
      } else {
        // Transient/unknown failure: release the key so the client can retry with it.
        await this.prisma.idempotencyRecord.deleteMany({ where: { id: recordId, status: 'IN_PROGRESS', resourceId: null } });
      }
      throw err;
    }
  }

  /** Link the record to the created resource inside the business transaction (crash recovery). */
  async attachResource(tx: DbClient, recordId: string, resourceId: string): Promise<void> {
    await tx.idempotencyRecord.update({ where: { id: recordId }, data: { resourceId } });
  }

  async complete(db: DbClient, recordId: string, status: number, body: unknown, resourceId?: string): Promise<void> {
    await db.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        status: 'COMPLETED',
        responseStatusCode: status,
        responseBody: JSON.parse(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue,
        ...(resourceId ? { resourceId } : {}),
      },
    });
  }

  static readonly CREATED = HttpStatus.CREATED;
}
