import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LimitsModule } from '../limits/limits.module';
import { PaymentsModule } from '../payments/payments.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProvidersModule } from '../providers/providers.module';
import { StaticQrController } from './static-qr.controller';
import { StaticQrService } from './static-qr.service';

@Module({
  imports: [AccessModule, AuditModule, LedgerModule, LimitsModule, PaymentsModule, PricingModule, ProvidersModule],
  controllers: [StaticQrController],
  providers: [StaticQrService],
  exports: [StaticQrService],
})
export class StaticQrModule {}
