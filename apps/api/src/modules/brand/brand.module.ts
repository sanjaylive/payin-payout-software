import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BrandController } from './brand.controller';
import { BrandSettingsService } from './brand-settings.service';

@Module({
  imports: [AuditModule],
  controllers: [BrandController],
  providers: [BrandSettingsService],
})
export class BrandModule {}
