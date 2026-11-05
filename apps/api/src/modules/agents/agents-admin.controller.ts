import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AGENT_PLAN_CODES,
  agentAdminListQuerySchema,
  agentAdminStatusSchema,
  agentGrantPlanSchema,
  agentPlanUpdateSchema,
  agentProgramSettingsSchema,
  idSchema,
} from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { AgentAdminService } from './agent-admin.service';
import { AgentBillingService } from './agent-billing.service';

const agentIdParam = new ZodValidationPipe(idSchema('org'));
const planCodeParam = new ZodValidationPipe(z.enum(AGENT_PLAN_CODES));

/** Platform staff: the agent program (Admin → Agents). */
@ApiTags('Admin: agents')
@ApiBearerAuth()
@Controller('v1/admin')
export class AgentsAdminController {
  constructor(
    private readonly admin: AgentAdminService,
    private readonly billing: AgentBillingService,
  ) {}

  @Get('agents/overview')
  @RequirePermissions('agent.admin.read')
  @ApiOperation({ summary: 'Agent counts by plan, this month’s volume and plan revenue' })
  overview(@CurrentActor() actor: Actor) {
    return this.admin.overview(actor);
  }

  @Get('agents')
  @RequirePermissions('agent.admin.read')
  @ApiOperation({ summary: 'Agents, newest first' })
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(agentAdminListQuerySchema)) q: z.output<typeof agentAdminListQuerySchema>) {
    return this.admin.list(actor, q);
  }

  @Get('agents/:agentId')
  @RequirePermissions('agent.admin.read')
  @ApiOperation({ summary: 'One agent: plan, usage, orders' })
  get(@CurrentActor() actor: Actor, @Param('agentId', agentIdParam) id: string) {
    return this.admin.get(actor, id);
  }

  @Post('agents/:agentId/status')
  @HttpCode(200)
  @RequirePermissions('agent.admin.manage')
  @ApiOperation({ summary: 'Suspend (signs everyone out) or reactivate an agent' })
  @ApiZodBody(agentAdminStatusSchema)
  status(@CurrentActor() actor: Actor, @Param('agentId', agentIdParam) id: string, @Body(new ZodValidationPipe(agentAdminStatusSchema)) body: z.output<typeof agentAdminStatusSchema>) {
    return this.admin.setStatus(actor, id, body);
  }

  @Post('agents/:agentId/plan')
  @HttpCode(200)
  @RequirePermissions('agent.admin.manage')
  @ApiOperation({ summary: 'Grant a plan until a date without payment (or reset to Free)' })
  @ApiZodBody(agentGrantPlanSchema)
  grant(@CurrentActor() actor: Actor, @Param('agentId', agentIdParam) id: string, @Body(new ZodValidationPipe(agentGrantPlanSchema)) body: z.output<typeof agentGrantPlanSchema>) {
    return this.billing.grant(actor, id, body);
  }

  @Get('agent-plans')
  @RequirePermissions('agent.admin.read')
  @ApiOperation({ summary: 'Agent plans including switched-off ones' })
  plans(@CurrentActor() actor: Actor) {
    return this.admin.plansList(actor);
  }

  @Patch('agent-plans/:code')
  @RequirePermissions('agent.admin.manage')
  @ApiOperation({ summary: 'Edit a plan’s prices, limits and features' })
  @ApiZodBody(agentPlanUpdateSchema)
  updatePlan(@CurrentActor() actor: Actor, @Param('code', planCodeParam) code: (typeof AGENT_PLAN_CODES)[number], @Body(new ZodValidationPipe(agentPlanUpdateSchema)) body: z.output<typeof agentPlanUpdateSchema>) {
    return this.admin.updatePlan(actor, code, body);
  }

  @Get('agent-settings')
  @RequirePermissions('agent.admin.read')
  @ApiOperation({ summary: 'Agent program settings (billing merchant)' })
  settings(@CurrentActor() actor: Actor) {
    return this.billing.settings(actor);
  }

  @Put('agent-settings')
  @RequirePermissions('agent.admin.manage')
  @ApiOperation({ summary: 'Set the merchant that collects plan fees' })
  @ApiZodBody(agentProgramSettingsSchema)
  updateSettings(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentProgramSettingsSchema)) body: z.output<typeof agentProgramSettingsSchema>) {
    return this.billing.updateSettings(actor, body.billing_merchant_id);
  }
}
