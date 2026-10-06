import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LimitsModule } from '../limits/limits.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { AdjustmentsService } from './adjustments.service';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AccessModule, AuditModule, MerchantsModule, LimitsModule],
  controllers: [LedgerController],
  providers: [LedgerService, AdjustmentsService],
  exports: [LedgerService],
})
export class LedgerModule {}
