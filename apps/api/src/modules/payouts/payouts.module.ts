import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LimitsModule } from '../limits/limits.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProvidersModule } from '../providers/providers.module';
import { BeneficiariesService } from './beneficiaries.service';
import { BulkPayoutsService } from './bulk-payouts.service';
import { PayoutProcessorService } from './payout-processor.service';
import { PayoutTransitionsService } from './payout-transitions.service';
import { BeneficiariesController, PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [AccessModule, AuditModule, AuthModule, LedgerModule, LimitsModule, PricingModule, ProvidersModule],
  controllers: [PayoutsController, BeneficiariesController],
  providers: [BeneficiariesService, PayoutTransitionsService, PayoutsService, PayoutProcessorService, BulkPayoutsService],
  exports: [PayoutTransitionsService, PayoutProcessorService, BulkPayoutsService, PayoutsService],
})
export class PayoutsModule {}
