import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { amountSchema, idSchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequireAnyPermission, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { CommissionsService } from './commissions.service';

const orgId = new ZodValidationPipe(idSchema('org'));
const payoutSchema = z.strictObject({
  amount: amountSchema.refine((v) => v > 0n, 'Amount must be positive'),
  utr: z.string().trim().regex(/^[A-Za-z0-9]{6,40}$/),
  period_note: z.string().trim().max(120).optional(),
});

@ApiTags('Reseller commissions')
@ApiBearerAuth()
@Controller('v1/resellers')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Get('commissions')
  @RequirePermissions('ledger.platform.read')
  @ApiOperation({ summary: 'Platform: commission payable per reseller' })
  overview() {
    return this.commissions.overview();
  }

  @Get(':id/earnings')
  @RequireAnyPermission('ledger.read', 'ledger.platform.read')
  @ApiOperation({ summary: 'Commission balance, accruals and per-merchant margins for a month (IST)' })
  earnings(@CurrentActor() actor: Actor, @Param('id', orgId) id: string, @Query('month') month?: string) {
    const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    return this.commissions.earnings(actor, id, m);
  }

  @Post(':id/commission-payouts')
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Platform finance: record a commission transfer to the reseller' })
  @ApiZodBody(payoutSchema)
  payout(@CurrentActor() actor: Actor, @Param('id', orgId) id: string, @Body(new ZodValidationPipe(payoutSchema)) body: z.output<typeof payoutSchema>) {
    return this.commissions.recordPayout(actor, id, body);
  }
}
