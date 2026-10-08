import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { FundsController, StatementsController } from './funds.controller';
import { FundsService } from './funds.service';
import { StatementsService } from './statements.service';

@Module({
  imports: [AuditModule, LedgerModule],
  controllers: [FundsController, StatementsController],
  providers: [FundsService, StatementsService],
})
export class FundsModule {}
