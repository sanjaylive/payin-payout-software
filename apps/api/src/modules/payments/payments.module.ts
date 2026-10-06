import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LimitsModule } from '../limits/limits.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProvidersModule } from '../providers/providers.module';
import { InboundEventsService } from './inbound-events.service';
import { MerchantEventsService } from './merchant-events.service';
import { PayinJobsService } from './payin-jobs.service';
import { PaymentTransitionsService } from './payment-transitions.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ProviderWebhooksController } from './provider-webhooks.controller';
import { RefundsService } from './refunds.service';
import { SandboxService } from './sandbox.service';

@Module({
  imports: [AccessModule, AuditModule, LedgerModule, LimitsModule, PricingModule, ProvidersModule],
  controllers: [PaymentsController, ProviderWebhooksController],
  providers: [MerchantEventsService, PaymentTransitionsService, PaymentsService, RefundsService, InboundEventsService, SandboxService, PayinJobsService],
  exports: [PaymentsService, PayinJobsService, MerchantEventsService, PaymentTransitionsService],
})
export class PaymentsModule {}
