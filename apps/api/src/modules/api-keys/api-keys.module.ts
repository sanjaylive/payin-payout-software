import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

@Module({
  imports: [AccessModule, AuditModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthService],
  exports: [ApiKeyAuthService],
})
export class ApiKeysModule {}
