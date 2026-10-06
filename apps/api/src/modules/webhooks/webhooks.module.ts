import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { EventPipelineController, WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [AccessModule, AuditModule],
  controllers: [WebhooksController, EventPipelineController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
