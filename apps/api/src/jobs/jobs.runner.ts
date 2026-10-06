import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { everySeconds, type ScheduledJob, Scheduler } from '@pay2all/events';
import type Redis from 'ioredis';
import { REDIS } from '../infra/tokens';
import { PayinJobsService } from '../modules/payments/payin-jobs.service';

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

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly payin: PayinJobsService,
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
        job('inbound-retry', 60, () => this.payin.retryInboundEvents()),
        job('idempotency-sweeper', 60, () => this.payin.sweepIdempotency()),
      ],
      5_000,
    );
    this.scheduler.start();
    this.logger.log('Payin jobs started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler?.stop();
  }
}
