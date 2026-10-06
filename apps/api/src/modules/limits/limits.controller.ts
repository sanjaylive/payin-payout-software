import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { effectiveLimitQuerySchema, limitQuerySchema, upsertApprovalPolicySchema, upsertLimitSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { LimitsService } from './limits.service';

@ApiTags('Limits & approval policies')
@ApiBearerAuth()
@Controller('v1')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  @Get('limits')
  @RequirePermissions('limit.read')
  @ApiZodQuery(limitQuerySchema)
  get(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(limitQuerySchema)) q: z.output<typeof limitQuerySchema>) {
    return this.limits.get(actor, q.level, q.subject_id);
  }

  @Put('limits')
  @RequirePermissions('limit.manage')
  @ApiOperation({ summary: 'Set limits for a level (null clears a field to inherit; resellers can only tighten)' })
  @ApiZodBody(upsertLimitSchema)
  upsert(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(upsertLimitSchema)) body: z.output<typeof upsertLimitSchema>) {
    return this.limits.upsert(actor, body);
  }

  @Get('limits/effective')
  @RequirePermissions('limit.read')
  @ApiOperation({ summary: 'Effective limits for a merchant, with the level each value comes from' })
  @ApiZodQuery(effectiveLimitQuerySchema)
  effective(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(effectiveLimitQuerySchema)) q: z.output<typeof effectiveLimitQuerySchema>) {
    return this.limits.effective(actor, q.merchant_id);
  }

  @Get('approval-policies')
  @RequirePermissions('payout.read')
  @ApiZodQuery(limitQuerySchema)
  getPolicy(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(limitQuerySchema)) q: z.output<typeof limitQuerySchema>) {
    return this.limits.getPolicy(actor, q.level, q.subject_id);
  }

  @Get('approval-policies/effective')
  @RequirePermissions('payout.read')
  @ApiZodQuery(effectiveLimitQuerySchema)
  effectivePolicy(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(effectiveLimitQuerySchema)) q: z.output<typeof effectiveLimitQuerySchema>) {
    return this.limits.effectivePolicyForMerchant(actor, q.merchant_id);
  }

  @Put('approval-policies')
  @RequirePermissions('approval_policy.manage')
  @ApiOperation({ summary: 'Configure payout maker-checker tiers (cannot be looser than the parent level)' })
  @ApiZodBody(upsertApprovalPolicySchema)
  upsertPolicy(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(upsertApprovalPolicySchema)) body: z.output<typeof upsertApprovalPolicySchema>) {
    return this.limits.upsertPolicy(actor, body);
  }
}
