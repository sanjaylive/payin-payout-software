import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LimitsModule } from '../limits/limits.module';
import { RiskEngineService } from './risk-engine.service';

/** Inline risk checks, imported by payments and payouts (no dependency back on them). */
@Module({
  imports: [AuditModule, LimitsModule],
  providers: [RiskEngineService],
  exports: [RiskEngineService],
})
export class RiskEngineModule {}
