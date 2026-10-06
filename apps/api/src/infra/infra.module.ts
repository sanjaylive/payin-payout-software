import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createKeyring, FieldEncryptor } from '@pay2all/auth';
import { createPrismaClient, type PrismaClient } from '@pay2all/database';
import Redis from 'ioredis';
import { ApiConfig } from '../config/api-config';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { MerchantEventsService } from './merchant-events.service';
import { NotificationsService } from './notifications.service';
import { OutboxService } from './outbox.service';
import { StorageService } from './storage.service';
import { PRISMA, REDIS } from './tokens';

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ApiConfig],
      useFactory: (config: ApiConfig) =>
        createPrismaClient({
          url: config.env.DATABASE_URL,
          poolMax: config.env.DATABASE_POOL_MAX,
          applicationName: 'pay2all-api',
        }),
    },
    {
      provide: REDIS,
      inject: [ApiConfig],
      useFactory: (config: ApiConfig) =>
        new Redis(config.env.REDIS_URL, {
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          lazyConnect: false,
        }),
    },
    {
      provide: FieldEncryptor,
      inject: [ApiConfig],
      useFactory: (config: ApiConfig) => new FieldEncryptor(createKeyring(config.env.ENCRYPTION_KEY_ID, { [config.env.ENCRYPTION_KEY_ID]: config.env.ENCRYPTION_KEY })),
    },
    RateLimitService,
    NotificationsService,
    StorageService,
    OutboxService,
    IdempotencyService,
    MerchantEventsService,
  ],
  exports: [PRISMA, REDIS, FieldEncryptor, RateLimitService, NotificationsService, StorageService, OutboxService, IdempotencyService, MerchantEventsService],
})
export class InfraModule implements OnApplicationShutdown {
  private readonly logger = new Logger(InfraModule.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
    this.logger.log('Datastore connections closed');
  }
}
