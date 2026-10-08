import { Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { idSchema, paginationQuerySchema } from '@pay2all/validation';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuthenticatedOnly, CurrentActor } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { InboxRealtimeService } from './inbox-realtime.service';
import { InboxService } from './inbox.service';

const listSchema = paginationQuerySchema.extend({
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  category: z.enum(['PAYMENT', 'PAYOUT', 'SETTLEMENT', 'RISK', 'SECURITY', 'COMPLIANCE', 'WEBHOOK', 'REPORT', 'SYSTEM', 'WALLET']).optional(),
});
const notificationId = new ZodValidationPipe(idSchema('inb'));

/** The signed-in user's own notifications — no permission beyond being signed in. */
@ApiTags('Notifications')
@ApiBearerAuth()
@AuthenticatedOnly()
@Controller('v1/inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly realtime: InboxRealtimeService,
  ) {}

  @Get()
  @ApiZodQuery(listSchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listSchema)) q: z.output<typeof listSchema>) {
    return this.inbox.list(actor, q);
  }

  @Get('unread-count')
  unread(@CurrentActor() actor: Actor) {
    return this.inbox.unreadCount(actor);
  }

  @Get('stream')
  @ApiOperation({ summary: 'Server-Sent Events: `ready` (unread count), `notification` (new item), `resync`' })
  async stream(@CurrentActor() actor: Actor, @Res() res: Response) {
    await this.realtime.open(actor, res);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentActor() actor: Actor) {
    return this.inbox.markAllRead(actor);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentActor() actor: Actor, @Param('id', notificationId) id: string) {
    return this.inbox.markRead(actor, id, true);
  }

  @Post(':id/unread')
  @HttpCode(200)
  unreadOne(@CurrentActor() actor: Actor, @Param('id', notificationId) id: string) {
    return this.inbox.markRead(actor, id, false);
  }
}
