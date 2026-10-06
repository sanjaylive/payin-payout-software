import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { MerchantAccessService } from './merchant-access.service';
import { MerchantPartiesService } from './merchant-parties.service';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';

@Module({
  imports: [AccessModule, AuditModule, AuthModule],
  controllers: [MerchantsController, ComplianceController, DocumentsController],
  providers: [MerchantAccessService, MerchantsService, MerchantPartiesService, DocumentsService, ComplianceService],
  exports: [MerchantAccessService, MerchantsService],
})
export class MerchantsModule {}
