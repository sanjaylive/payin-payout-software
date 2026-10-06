import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadEnv, workerEnvSchema } from '@pay2all/config';
import { createPrismaClient } from '@pay2all/database';
import { createLogger } from '@pay2all/logger';
import Redis from 'ioredis';
import { balanceSnapshotJob, ledgerVerificationJob } from './jobs/ledger-jobs';
import { providerHealthJob, providerSnapshotJob } from './jobs/provider-health-job';
import { Scheduler } from './jobs/scheduler';

/**
 * Pay2All worker process.
 *
 * Phase 1: process lifecycle — datastore connections, health endpoint, graceful shutdown.
 * Phase 3: scheduled ledger jobs (hourly balance verification, daily 00:00 IST snapshots).
 * Phase 4: provider health (probes + circuit breaker, the single writer of AUTO statuses) and snapshots.
 * Phase 7 registers the outbox relay and Kafka consumers here (docs/ARCHITECTURE.md §8).
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  }
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger({ service: 'pay2all-worker', level: env.LOG_LEVEL, base: { env: env.NODE_ENV } });

  const prisma = createPrismaClient({ url: env.DATABASE_URL, poolMax: 5, applicationName: 'pay2all-worker' });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  const server: Server = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/health/ready') {
      Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()])
        .then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'))
        .catch(() => res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"unavailable"}'));
      return;
    }
    res.writeHead(404).end();
  });
  const scheduler = new Scheduler(redis, logger, [
    ledgerVerificationJob(prisma, logger),
    balanceSnapshotJob(prisma),
    providerHealthJob(prisma, redis, logger, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_ID),
    providerSnapshotJob(prisma, redis),
  ]);
  scheduler.start();

  server.listen(env.WORKER_HEALTH_PORT, () => logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker started'));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down');
    server.close();
    // Let in-flight jobs finish; consumers (Phase 7) will also commit offsets here.
    void scheduler
      .stop()
      .then(() => Promise.allSettled([prisma.$disconnect(), redis.quit()]))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'Worker failed to start', error: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
