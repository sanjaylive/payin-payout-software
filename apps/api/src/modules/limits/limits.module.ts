import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { PeriodUsageService } from './period-usage.service';

@Module({
  imports: [AccessModule, AuditModule, MerchantsModule],
  controllers: [LimitsController],
  providers: [LimitsService, PeriodUsageService],
  exports: [LimitsService, PeriodUsageService],
})
export class LimitsModule {}
