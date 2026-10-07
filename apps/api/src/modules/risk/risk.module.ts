import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { RiskEngineModule } from './risk-engine.module';
import { RiskSweepService } from './risk-sweep.service';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

@Module({
  imports: [AccessModule, AuditModule, LedgerModule, PayoutsModule, RiskEngineModule],
  controllers: [RiskController],
  providers: [RiskService, RiskSweepService],
  exports: [RiskService, RiskSweepService],
})
export class RiskModule {}
