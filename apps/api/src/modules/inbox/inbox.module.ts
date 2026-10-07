import { Module } from '@nestjs/common';
import { InboxRealtimeService } from './inbox-realtime.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({ controllers: [InboxController], providers: [InboxService, InboxRealtimeService] })
export class InboxModule {}
