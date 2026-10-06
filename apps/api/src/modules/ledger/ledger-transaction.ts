import { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient, type TransactionClient } from '@pay2all/database';

const RETRYABLE_SQLSTATE = ['40P01', '40001', '55P03'];
const logger = new Logger('LedgerTransaction');

function isRetryable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})}` : '';
  return RETRYABLE_SQLSTATE.some((code) => text.includes(code)) || /deadlock detected|lock timeout|could not serialize/i.test(text);
}

/**
 * Run a money-moving unit of work: READ COMMITTED + explicit row locks, bounded lock waits, and a
 * jittered retry on deadlock/lock-timeout/serialization failure (docs/LEDGER.md §6).
 *
 * Retrying is safe ONLY because every journal posted inside carries an idempotency key, so a retry
 * finds the first journal instead of posting a second one.
 */
export async function runLedgerTransaction<T>(prisma: PrismaClient, work: (tx: TransactionClient) => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
          return work(tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 },
      );
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delay = 20 * 2 ** attempt + Math.floor(Math.random() * 30);
      logger.warn({ attempt, delay }, 'Retrying ledger transaction after lock conflict');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
