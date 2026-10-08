import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createStaticQrSchema, idSchema, staticQrIdSchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { StaticQrService } from './static-qr.service';

const listQuery = z.strictObject({ merchant_id: idSchema('org').optional() });

@ApiTags('Static QR')
@ApiBearerAuth()
@Controller('v1/static-qrs')
export class StaticQrController {
  constructor(private readonly qrs: StaticQrService) {}

  @Get()
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Your static UPI QR codes with today’s collections' })
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listQuery)) q: z.output<typeof listQuery>) {
    return this.qrs.list(actor, q.merchant_id);
  }

  @Post()
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Create a printable static UPI QR (customers pay any amount)' })
  @ApiZodBody(createStaticQrSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createStaticQrSchema)) body: z.output<typeof createStaticQrSchema>) {
    return this.qrs.create(actor, body.label);
  }

  @Get(':qrId/payments')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Payments received on a static QR' })
  credits(@CurrentActor() actor: Actor, @Param('qrId', new ZodValidationPipe(staticQrIdSchema)) id: string) {
    return this.qrs.credits(actor, id);
  }

  @Post(':qrId/close')
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Close a static QR (it stops accepting payments at the provider)' })
  close(@CurrentActor() actor: Actor, @Param('qrId', new ZodValidationPipe(staticQrIdSchema)) id: string) {
    return this.qrs.close(actor, id);
  }
}
