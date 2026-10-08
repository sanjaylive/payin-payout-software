import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { FundsController } from './funds.controller';
import { FundsService } from './funds.service';

@Module({
  imports: [AuditModule, LedgerModule],
  controllers: [FundsController],
  providers: [FundsService],
})
export class FundsModule {}
