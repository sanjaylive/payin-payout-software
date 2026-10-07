import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createRiskRuleSchema,
  idSchema,
  liftRiskActionSchema,
  listRiskActionsQuerySchema,
  listRiskEventsQuerySchema,
  resolveRiskEventSchema,
  updateRiskRuleSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { RiskService } from './risk.service';

const ruleId = new ZodValidationPipe(idSchema('rrl'));
const eventId = new ZodValidationPipe(idSchema('rev'));
const actionId = new ZodValidationPipe(idSchema('rac'));

@ApiTags('Risk')
@ApiBearerAuth()
@Controller('v1/risk')
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Get('rules')
  @RequirePermissions('risk.read')
  listRules(@CurrentActor() actor: Actor) {
    return this.risk.listRules(actor);
  }

  @Post('rules')
  @RequirePermissions('risk.manage')
  @ApiOperation({ summary: 'Create a risk rule (defaults to MONITOR mode: records hits, takes no action)' })
  @ApiZodBody(createRiskRuleSchema)
  createRule(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createRiskRuleSchema)) body: z.output<typeof createRiskRuleSchema>) {
    return this.risk.createRule(actor, body);
  }

  @Patch('rules/:id')
  @RequirePermissions('risk.manage')
  @ApiOperation({ summary: 'Change thresholds, action, mode or enabled (audited, reason required; bumps the rule version)' })
  @ApiZodBody(updateRiskRuleSchema)
  updateRule(@CurrentActor() actor: Actor, @Param('id', ruleId) id: string, @Body(new ZodValidationPipe(updateRiskRuleSchema)) body: z.output<typeof updateRiskRuleSchema>) {
    return this.risk.updateRule(actor, id, body);
  }

  @Get('events')
  @RequirePermissions('risk.read')
  @ApiZodQuery(listRiskEventsQuerySchema)
  listEvents(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listRiskEventsQuerySchema)) q: z.output<typeof listRiskEventsQuerySchema>) {
    return this.risk.listEvents(actor, q);
  }

  @Get('events/:id')
  @RequirePermissions('risk.read')
  getEvent(@CurrentActor() actor: Actor, @Param('id', eventId) id: string) {
    return this.risk.getEvent(actor, id);
  }

  @Post('events/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('risk.review')
  @ApiOperation({ summary: 'Resolve a review: CLEAR (lift actions, release a held payout) or CONFIRM (keep actions, reject a held payout)' })
  @ApiZodBody(resolveRiskEventSchema)
  resolve(@CurrentActor() actor: Actor, @Param('id', eventId) id: string, @Body(new ZodValidationPipe(resolveRiskEventSchema)) body: z.output<typeof resolveRiskEventSchema>) {
    return this.risk.resolve(actor, id, body);
  }

  @Get('actions')
  @RequirePermissions('risk.read')
  @ApiZodQuery(listRiskActionsQuerySchema)
  listActions(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listRiskActionsQuerySchema)) q: z.output<typeof listRiskActionsQuerySchema>) {
    return this.risk.listActions(actor, q);
  }

  @Post('actions/:id/lift')
  @HttpCode(200)
  @RequirePermissions('risk.review')
  @ApiOperation({ summary: 'Lift one active risk control (settlement hold / disabled service) — audited' })
  @ApiZodBody(liftRiskActionSchema)
  lift(@CurrentActor() actor: Actor, @Param('id', actionId) id: string, @Body(new ZodValidationPipe(liftRiskActionSchema)) body: z.output<typeof liftRiskActionSchema>) {
    return this.risk.liftAction(actor, id, body.reason);
  }
}
