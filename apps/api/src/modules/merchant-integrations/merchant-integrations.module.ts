import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { MerchantIntegrationsController } from './merchant-integrations.controller';

@Module({ imports: [WebhooksModule, ApiKeysModule], controllers: [MerchantIntegrationsController] })
export class MerchantIntegrationsModule {}
