import { type DynamicModule, Module } from '@nestjs/common';
import { buildLoggerOptions } from '@pay2all/logger';
import { LoggerModule } from 'nestjs-pino';
import { ApiConfig } from '../config/api-config';
import { InfraModule } from '../infra/infra.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { JobsRunner } from './jobs.runner';

/**
 * Domain background jobs (payin status polling, expiry, refund dispatch, inbound-event retry,
 * idempotency hygiene). Runs as a separate process from the HTTP API (`jobs.main.ts`) but reuses
 * the same services, so a poll and a callback go through identical transition code.
 */
@Module({})
export class JobsModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: JobsModule,
      imports: [
        LoggerModule.forRoot({ pinoHttp: buildLoggerOptions({ service: 'pay2all-api-jobs', level: config.env.LOG_LEVEL, base: { env: config.env.NODE_ENV } }) }),
        { module: class ConfigHolderModule {}, global: true, providers: [{ provide: ApiConfig, useValue: config }], exports: [ApiConfig] },
        InfraModule,
        PaymentsModule,
      ],
      providers: [JobsRunner],
    };
  }
}
