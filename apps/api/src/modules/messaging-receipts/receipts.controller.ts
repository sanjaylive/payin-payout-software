import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { idSchema } from '@pay2all/validation';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public, RequirePermissions, RequireStepUp } from '../access/decorators';
import { ReceiptsService } from './receipts.service';

/** Vendors post delivery receipts here (signature-verified; no session). */
@ApiTags('Messaging')
@Controller('v1/webhooks/messaging')
export class MessagingReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Public()
  @Post('sms21/:serviceId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  sms21(@Param('serviceId') serviceId: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | undefined>) {
    return this.receipts.sms21(serviceId, req.rawBody, headers);
  }

  @Public()
  @Post('ses/:serviceId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  ses(@Param('serviceId') serviceId: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.receipts.ses(serviceId, req.rawBody);
  }
}

@ApiTags('Messaging')
@ApiBearerAuth()
@Controller('v1/messaging')
export class MessagingAdminController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get('suppressions')
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Email addresses no longer sent to (hard bounce or complaint); masked' })
  suppressions() {
    return this.receipts.suppressions();
  }

  @Delete('suppressions/:id')
  @RequireStepUp()
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Allow sending to an address again (only after it was fixed)' })
  unsuppress(@Param('id', new ZodValidationPipe(idSchema('sup'))) id: string) {
    return this.receipts.unsuppress(id);
  }

  @Get('services/:id/delivery')
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Delivery receipts for a messaging service over the last 7 days' })
  delivery(@Param('id', new ZodValidationPipe(idSchema('msv'))) id: string) {
    return this.receipts.stats(id);
  }
}
