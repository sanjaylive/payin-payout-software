import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createPaymentSchema, createRefundSchema, idSchema, listPaymentsQuerySchema, listRefundsQuerySchema, paymentStatsQuerySchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

const paymentIdPipe = new ZodValidationPipe(idSchema('pay'));
const reviewSchema = z.strictObject({ reason: z.string().trim().min(5).max(500) });

@ApiTags('Payments (payin)')
@ApiBearerAuth()
@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Post('payments')
  @ApiKeyAccess()
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Create a payment (UPI QR / intent / link). Idempotent per Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiZodBody(createPaymentSchema)
  create(@CurrentActor() actor: Actor, @Body() raw: unknown, @Headers('idempotency-key') key: string | undefined) {
    const input = new ZodValidationPipe(createPaymentSchema).transform(raw);
    return this.payments.create(actor, input, raw, key);
  }

  @Get('payments')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiZodQuery(listPaymentsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listPaymentsQuerySchema)) q: z.output<typeof listPaymentsQuerySchema>) {
    return this.payments.list(actor, q);
  }

  @Get('payments/stats')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiZodQuery(paymentStatsQuerySchema)
  stats(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(paymentStatsQuerySchema)) q: z.output<typeof paymentStatsQuerySchema>) {
    return this.payments.stats(actor, q);
  }

  @Get('payments/:id')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  get(@CurrentActor() actor: Actor, @Param('id', paymentIdPipe) id: string) {
    return this.payments.get(actor, id);
  }

  @Post('payments/:id/refunds')
  @ApiKeyAccess()
  @RequirePermissions('payin.refund')
  @ApiOperation({ summary: 'Refund a captured payment (partial or full). Idempotent per Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiZodBody(createRefundSchema)
  refund(@CurrentActor() actor: Actor, @Param('id', paymentIdPipe) id: string, @Body() raw: unknown, @Headers('idempotency-key') key: string | undefined) {
    const input = new ZodValidationPipe(createRefundSchema).transform(raw);
    return this.refunds.create(actor, id, input, raw, key);
  }

  @Get('refunds')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiZodQuery(listRefundsQuerySchema)
  listRefunds(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listRefundsQuerySchema)) q: z.output<typeof listRefundsQuerySchema>) {
    return this.refunds.list(actor, q);
  }

  @Post('payments/:id/review/accept')
  @HttpCode(200)
  @RequirePermissions('risk.review')
  @ApiOperation({ summary: 'Accept a late success held for review (captures funds)' })
  @ApiZodBody(reviewSchema)
  accept(@CurrentActor() actor: Actor, @Param('id', paymentIdPipe) id: string, @Body(new ZodValidationPipe(reviewSchema)) body: z.output<typeof reviewSchema>) {
    return this.payments.acceptLateSuccess(actor, id, body.reason);
  }

}
