import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PricingModule } from '../pricing/pricing.module';
import { SchemesController } from './schemes.controller';
import { SchemesService } from './schemes.service';

@Module({
  imports: [AuditModule, PricingModule],
  controllers: [SchemesController],
  providers: [SchemesService],
})
export class SchemesModule {}
