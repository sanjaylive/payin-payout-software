import { Module } from '@nestjs/common';
import { MessagingAdminController, MessagingReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  controllers: [MessagingReceiptsController, MessagingAdminController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class MessagingReceiptsModule {}
