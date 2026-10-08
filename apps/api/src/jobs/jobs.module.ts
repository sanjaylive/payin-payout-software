import { type DynamicModule, Module } from '@nestjs/common';
import { buildLoggerOptions } from '@pay2all/logger';
import { LoggerModule } from 'nestjs-pino';
import { ApiConfig } from '../config/api-config';
import { InfraModule } from '../infra/infra.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { PayoutsModule } from '../modules/payouts/payouts.module';
import { ProviderEventsModule } from '../modules/provider-events/provider-events.module';
import { ReconciliationModule } from '../modules/reconciliation/reconciliation.module';
import { SettlementsModule } from '../modules/settlements/settlements.module';
import { CommissionsModule } from '../modules/commissions/commissions.module';
import { RiskModule } from '../modules/risk/risk.module';
import { ReportsModule } from '../modules/reports/reports.module';
import { StaticQrModule } from '../modules/static-qr/static-qr.module';
import { DisputesModule } from '../modules/disputes/disputes.module';
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
        PayoutsModule,
        ProviderEventsModule,
        SettlementsModule,
        ReconciliationModule,
        CommissionsModule,
        RiskModule,
        ReportsModule,
        StaticQrModule,
        DisputesModule,
      ],
      providers: [JobsRunner],
    };
  }
}
