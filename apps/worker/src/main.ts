import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadEnv, workerEnvSchema } from '@pay2all/config';
import { createPrismaClient } from '@pay2all/database';
import { createLogger } from '@pay2all/logger';
import Redis from 'ioredis';
import { balanceSnapshotJob, ledgerVerificationJob } from './jobs/ledger-jobs';
import { providerHealthJob, providerSnapshotJob } from './jobs/provider-health-job';
import { createKeyring, FieldEncryptor } from '@pay2all/auth';
import { createConsumerStore, type TransactionClient } from '@pay2all/database';
import { createKafka, EventPublisher, KNOWN_AGGREGATES, runConsumer, Scheduler, topicFor } from '@pay2all/events';
import type { Consumer } from 'kafkajs';
import { OutboxRelay } from './events/outbox-relay';
import { PollLoop } from './events/poll-loop';
import { processedEventsCleanupJob } from './jobs/maintenance-jobs';
import { NotificationSender } from './notifications/notifications';
import { dispatchMerchantEvent, WebhookSender } from './webhooks/webhooks';

/**
 * Pay2All worker process.
 *
 * Phase 1: process lifecycle — datastore connections, health endpoint, graceful shutdown.
 * Phase 3: scheduled ledger jobs (hourly balance verification, daily 00:00 IST snapshots).
 * Phase 4: provider health (probes + circuit breaker, the single writer of AUTO statuses) and snapshots.
 * Phase 7: outbox relay (single leader) → Kafka; consumers with processed_events dedupe and DLQ;
 * merchant webhook dispatch + signed delivery; notification email sender (docs/ARCHITECTURE.md §8).
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
    processedEventsCleanupJob(prisma),
  ]);
  scheduler.start();

  // ---- Event pipeline (Phase 7) ----
  const encryptor = new FieldEncryptor(createKeyring(env.ENCRYPTION_KEY_ID, { [env.ENCRYPTION_KEY_ID]: env.ENCRYPTION_KEY }));
  const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: `${env.KAFKA_CLIENT_ID}-worker` });
  const publisher = new EventPublisher(kafka, { replicationFactor: env.KAFKA_REPLICATION_FACTOR });
  await publisher.connect();
  await publisher.ensureTopics(KNOWN_AGGREGATES.map(topicFor));
  const relay = new OutboxRelay(prisma, redis, publisher, logger);
  relay.start();

  const store = createConsumerStore(prisma);
  const notifications = new NotificationSender(prisma, encryptor, logger, { smtpUrl: env.SMTP_URL, from: env.MAIL_FROM });
  const webhooks = new WebhookSender(prisma, encryptor, logger, { allowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS });
  const consumers: Consumer[] = [
    await runConsumer(kafka, { groupId: 'webhook-dispatcher', topics: ['payment', 'refund', 'payout'].map(topicFor), handle: async (e, tx) => void (await dispatchMerchantEvent(tx as TransactionClient, e)) }, { store, publisher, logger }),
    await runConsumer(kafka, { groupId: 'notification-sender', topics: [topicFor('notification')], eventTypes: ['notification.send'], idempotency: 'handler', handle: async (e) => void (await notifications.sendDue(1, e.aggregate_id)) }, { store, publisher, logger }),
  ];
  // Safety nets: pick up anything a consumer missed (Kafka down, crash between steps, retries due).
  const loops = [new PollLoop('webhook-sender', () => webhooks.sendDue(), logger, 500), new PollLoop('notification-sender', () => notifications.sendDue(), logger, 5_000)];
  for (const l of loops) l.start();

  server.listen(env.WORKER_HEALTH_PORT, () => logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker started'));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down');
    server.close();
    // Stop intake first, let in-flight work finish (consumers commit their offsets), then close.
    void Promise.allSettled(consumers.map((c) => c.disconnect()))
      .then(() => Promise.allSettled([relay.stop(), ...loops.map((l) => l.stop()), scheduler.stop()]))
      .then(() => publisher.disconnect())
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
