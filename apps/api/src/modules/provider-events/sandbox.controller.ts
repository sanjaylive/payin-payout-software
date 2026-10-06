import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { idSchema, sandboxCompleteSchema, sandboxPayoutSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { SandboxService } from './sandbox.service';

/** Sandbox-only simulators: signed mock provider callbacks through the real inbound path. */
@ApiTags('Sandbox')
@ApiBearerAuth()
@Controller('v1/sandbox')
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post('payments/:id/complete')
  @HttpCode(200)
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Sandbox only: simulate the customer paying (or declining) via a signed mock callback' })
  @ApiZodBody(sandboxCompleteSchema)
  payment(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('pay'))) id: string, @Body(new ZodValidationPipe(sandboxCompleteSchema)) body: z.output<typeof sandboxCompleteSchema>) {
    return this.sandbox.completePayment(actor, id, body.outcome);
  }

  @Post('payouts/:id/complete')
  @HttpCode(200)
  @RequirePermissions('payout.read')
  @ApiOperation({ summary: 'Sandbox only: simulate the bank completing, failing or returning a sent payout' })
  @ApiZodBody(sandboxPayoutSchema)
  payout(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('pout'))) id: string, @Body(new ZodValidationPipe(sandboxPayoutSchema)) body: z.output<typeof sandboxPayoutSchema>) {
    return this.sandbox.completePayout(actor, id, body.outcome);
  }
}
