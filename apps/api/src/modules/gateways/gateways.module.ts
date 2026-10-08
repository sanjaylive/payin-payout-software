import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProvidersModule } from '../providers/providers.module';
import { GatewaysController } from './gateways.controller';
import { GatewaysService } from './gateways.service';

@Module({
  imports: [AuditModule, ProvidersModule],
  controllers: [GatewaysController],
  providers: [GatewaysService],
  exports: [GatewaysService],
})
export class GatewaysModule {}
