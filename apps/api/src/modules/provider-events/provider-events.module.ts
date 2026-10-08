import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ProvidersModule } from '../providers/providers.module';
import { StaticQrModule } from '../static-qr/static-qr.module';
import { InboundEventsService } from './inbound-events.service';
import { ProviderWebhooksController } from './provider-webhooks.controller';
import { SandboxController } from './sandbox.controller';
import { SandboxService } from './sandbox.service';

/** Inbound provider callbacks for every flow, and the sandbox simulators that produce them. */
@Module({
  imports: [AccessModule, AuditModule, LedgerModule, ProvidersModule, PaymentsModule, PayoutsModule, StaticQrModule],
  controllers: [ProviderWebhooksController, SandboxController],
  providers: [InboundEventsService, SandboxService],
  exports: [InboundEventsService],
})
export class ProviderEventsModule {}
