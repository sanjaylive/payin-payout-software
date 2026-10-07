import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client';

export * from './generated/prisma/client';

/** Client usable inside `prisma.$transaction(async (tx) => …)` callbacks. */
export type TransactionClient = Prisma.TransactionClient;

/** Either the root client or a transaction client — services that may join a caller's transaction take this. */
export type DbClient = PrismaClient | TransactionClient;

export interface CreatePrismaClientOptions {
  url: string;
  /** Max pool connections per process. Keep (replicas x poolMax) below PgBouncer/Postgres limits. */
  poolMax?: number;
  /** Fail fast instead of queueing forever when the pool is exhausted. */
  connectionTimeoutMs?: number;
  /** Abort runaway statements server-side. */
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function createPrismaClient(opts: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: opts.url,
    max: opts.poolMax ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: opts.applicationName ?? 'pay2all',
  });
  return new PrismaClient({ adapter });
}

/** Postgres SQLSTATE codes we branch on. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  RAISE_EXCEPTION: 'P0001',
} as const;

/** True for Prisma's unique-constraint error (P2002), optionally on a specific target column set. */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!target) return true;
  return JSON.stringify(err.meta ?? {}).includes(target);
}
export * from './consumer-store';
export * from './inbox';
