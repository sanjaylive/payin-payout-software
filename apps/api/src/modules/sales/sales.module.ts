import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AccessModule, AuditModule, MerchantsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
