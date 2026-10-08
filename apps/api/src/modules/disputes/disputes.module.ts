import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminDisputesController, DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({
  imports: [AccessModule, AuditModule, LedgerModule, PaymentsModule],
  controllers: [DisputesController, AdminDisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
