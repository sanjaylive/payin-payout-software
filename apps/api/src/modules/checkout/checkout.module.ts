import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProvidersModule } from '../providers/providers.module';
import { AdminWebsitesController, CheckoutController, PublicCheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PaymentLinksController, PaymentPagesController, PublicPaymentPagesController } from './payment-links.controller';
import { PaymentLinksService } from './payment-links.service';
import { PaymentPagesService } from './payment-pages.service';

@Module({
  imports: [AuditModule, PaymentsModule, ProvidersModule, GatewaysModule],
  controllers: [CheckoutController, PublicCheckoutController, AdminWebsitesController, PaymentLinksController, PaymentPagesController, PublicPaymentPagesController],
  providers: [CheckoutService, PaymentLinksService, PaymentPagesService],
})
export class CheckoutModule {}
