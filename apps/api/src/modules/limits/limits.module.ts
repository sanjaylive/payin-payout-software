import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';

@Module({
  imports: [AccessModule, AuditModule, MerchantsModule],
  controllers: [LimitsController],
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
