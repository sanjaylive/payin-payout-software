import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderWebhooksController } from './provider-webhooks.controller';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { RoutingService } from './routing.service';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [ProvidersController, ProviderWebhooksController],
  providers: [ProviderRegistryService, ProvidersService, RoutingService],
  exports: [ProviderRegistryService, RoutingService],
})
export class ProvidersModule {}
