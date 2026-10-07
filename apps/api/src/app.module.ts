import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { buildLoggerOptions } from '@pay2all/logger';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { RequestContextMiddleware, resolveRequestId } from './common/context/request-context.middleware';
import { ApiConfig } from './config/api-config';
import { InfraModule } from './infra/infra.module';
import { AccessModule } from './modules/access/access.module';
import type { RequestWithActor } from './modules/access/decorators';
import { PermissionGuard } from './modules/access/permission.guard';
import { AuditModule } from './modules/audit/audit.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { IamModule } from './modules/iam/iam.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { LimitsModule } from './modules/limits/limits.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ProviderEventsModule } from './modules/provider-events/provider-events.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { CommissionsModule } from './modules/commissions/commissions.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { RiskModule } from './modules/risk/risk.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SystemModule } from './modules/system/system.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { LoginEventsModule } from './modules/login-events/login-events.module';
import { MerchantIntegrationsModule } from './modules/merchant-integrations/merchant-integrations.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { SalesModule } from './modules/sales/sales.module';

@Module({})
export class AppModule implements NestModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Logger first so pino-http assigns req.id before RequestContextMiddleware runs.
        LoggerModule.forRoot({
          pinoHttp: {
            ...buildLoggerOptions({ service: 'pay2all-api', level: config.env.LOG_LEVEL, base: { env: config.env.NODE_ENV } }),
            genReqId: (req) => resolveRequestId(req as Parameters<typeof resolveRequestId>[0]),
            customProps: (req: IncomingMessage) => {
              const actor = (req as RequestWithActor).actor;
              return { request_id: (req as { id?: unknown }).id, actor_id: actor?.userId, org_id: actor?.organizationId };
            },
            serializers: {
              // Minimal request serialization: no headers/bodies (secrets live there).
              req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url?.split('?')[0] }),
              res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
            },
            autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
            quietReqLogger: true,
          },
        }),
        {
          module: class ConfigHolderModule {},
          global: true,
          providers: [{ provide: ApiConfig, useValue: config }],
          exports: [ApiConfig],
        },
        InfraModule,
        AccessModule,
        AuditModule,
        AuthModule,
        IamModule,
        MerchantsModule,
        LimitsModule,
        SalesModule,
        LedgerModule,
        ProvidersModule,
        PricingModule,
        PaymentsModule,
        PayoutsModule,
        ProviderEventsModule,
        WebhooksModule,
        SettlementsModule,
        ReconciliationModule,
        CommissionsModule,
        RiskModule,
        ReportsModule,
        SystemModule,
        VendorsModule,
        LoginEventsModule,
        MerchantIntegrationsModule,
      ],
      controllers: [HealthController],
      providers: [
        // Order matters: authenticate, then authorize.
        { provide: APP_GUARD, useExisting: AuthGuard },
        { provide: APP_GUARD, useExisting: PermissionGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
