import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LimitsModule } from '../limits/limits.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProvidersModule } from '../providers/providers.module';
import { PayinJobsService } from './payin-jobs.service';
import { PaymentTransitionsService } from './payment-transitions.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({
  imports: [AccessModule, AuditModule, LedgerModule, LimitsModule, PricingModule, ProvidersModule],
  controllers: [PaymentsController],
  providers: [PaymentTransitionsService, PaymentsService, RefundsService, PayinJobsService],
  exports: [PaymentsService, PayinJobsService, PaymentTransitionsService, RefundsService],
})
export class PaymentsModule {}
