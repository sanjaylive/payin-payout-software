import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BrandController, ResellerBrandController } from './brand.controller';
import { BrandSettingsService } from './brand-settings.service';
import { ResellerBrandService } from './reseller-brand.service';

@Module({
  imports: [AuditModule],
  controllers: [BrandController, ResellerBrandController],
  providers: [BrandSettingsService, ResellerBrandService],
})
export class BrandModule {}
