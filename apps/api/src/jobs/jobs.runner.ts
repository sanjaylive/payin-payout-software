import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createConsumerStore, type PrismaClient } from '@pay2all/database';
import { createKafka, EventPublisher, everySeconds, runConsumer, type ScheduledJob, Scheduler, topicFor } from '@pay2all/events';
import type { Consumer } from 'kafkajs';
import { ApiConfig } from '../config/api-config';
import type Redis from 'ioredis';
import { PRISMA, REDIS } from '../infra/tokens';
import { PayinJobsService } from '../modules/payments/payin-jobs.service';
import { BulkPayoutsService } from '../modules/payouts/bulk-payouts.service';
import { PayoutProcessorService } from '../modules/payouts/payout-processor.service';
import { InboundEventsService } from '../modules/provider-events/inbound-events.service';

const job = (name: string, seconds: number, run: () => Promise<unknown>): ScheduledJob => ({
  name,
  dueKey: everySeconds(seconds),
  claimTtlSeconds: seconds * 4,
  run: async () => void (await run()),
});

@Injectable()
export class JobsRunner implements OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private scheduler: Scheduler | null = null;
  private consumer: Consumer | null = null;
  private publisher: EventPublisher | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly config: ApiConfig,
    private readonly payin: PayinJobsService,
    private readonly payouts: PayoutProcessorService,
    private readonly bulk: BulkPayoutsService,
    private readonly inbound: InboundEventsService,
  ) {}

  async start(): Promise<void> {
    // The shared client runs without an offline queue; wait for the first connection.
    if (this.redis.status !== 'ready') await new Promise<void>((resolve) => this.redis.once('ready', () => resolve()));
    const log = {
      info: (obj: object, msg: string) => this.logger.debug({ ...obj, msg }),
      error: (obj: object, msg: string) => this.logger.error({ ...obj, msg }),
    };
    this.scheduler = new Scheduler(
      this.redis,
      log,
      [
        job('payin-poller', 15, () => this.payin.pollOpenPayments()),
        job('payin-expiry', 60, () => this.payin.expireStalePayments()),
        job('refund-processor', 20, () => this.payin.processRefunds()),
        job('inbound-retry', 60, () => this.inbound.retryPending()),
        job('payout-processor', 5, () => this.payouts.processQueued()),
        job('payout-poller', 15, () => this.payouts.pollInFlight()),
        job('payout-approval-expiry', 300, () => this.payouts.expireApprovals()),
        job('bulk-payouts', 10, () => this.bulk.processConfirmed()),
        job('idempotency-sweeper', 60, () => this.payin.sweepIdempotency()),
      ],
      5_000,
    );
    this.scheduler.start();
    await this.startFastPath(log);
    this.logger.log('Payin and payout jobs started');
  }

  /**
   * Kafka fast path: send a payout the moment `payout.queued` is published instead of waiting for
   * the next poll. Optional — without brokers (or if Kafka is down) polling alone still works.
   */
  private async startFastPath(log: { info(o: object, m: string): void; error(o: object, m: string): void }) {
    const brokers = this.config.env.KAFKA_BROKERS;
    if (!brokers.length) return;
    try {
      const kafka = createKafka({ brokers, clientId: `${this.config.env.KAFKA_CLIENT_ID}-api-jobs` });
      this.publisher = new EventPublisher(kafka);
      this.consumer = await runConsumer(
        kafka,
        { groupId: 'payout-processor', topics: [topicFor('payout')], eventTypes: ['payout.queued'], idempotency: 'handler', handle: async (env) => void (await this.payouts.processQueued(1, env.aggregate_id)) },
        { store: createConsumerStore(this.prisma), publisher: this.publisher, logger: { ...log, warn: (o, m) => this.logger.warn({ ...o, msg: m }) } },
      );
      this.logger.log('Payout fast path consuming payout.queued');
    } catch (err) {
      this.logger.error({ err, msg: 'Kafka fast path unavailable; relying on polling' });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect().catch(() => undefined);
    await this.publisher?.disconnect().catch(() => undefined);
    await this.scheduler?.stop();
  }
}
