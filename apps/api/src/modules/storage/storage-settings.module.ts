import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StorageSettingsController } from './storage-settings.controller';
import { StorageSettingsService } from './storage-settings.service';

@Module({
  imports: [AuditModule],
  controllers: [StorageSettingsController],
  providers: [StorageSettingsService],
})
export class StorageSettingsModule {}
