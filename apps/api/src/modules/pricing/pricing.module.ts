import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({
  imports: [AuditModule, MerchantsModule],
  controllers: [PricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
