import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { dashboardIpRuleSchema, idSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from './actor';
import { DashboardIpService } from './dashboard-ip.service';

/** Organization-level sign-in security (docs/SECURITY.md §1.8), for the caller's own organization. */
@ApiTags('Security')
@ApiBearerAuth()
@Controller('v1/security')
export class SecurityController {
  constructor(private readonly dashboardIp: DashboardIpService) {}

  @Get('dashboard-ip')
  @RequirePermissions('user.read')
  @ApiOperation({ summary: 'Dashboard sign-in IP allowlist of your organization' })
  list(@CurrentActor() actor: Actor) {
    return this.dashboardIp.list(actor);
  }

  @Post('dashboard-ip')
  @RequirePermissions('user.manage')
  @RequireStepUp()
  @ApiOperation({ summary: 'Allow an address or range (your own address must stay allowed)' })
  @ApiZodBody(dashboardIpRuleSchema)
  add(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(dashboardIpRuleSchema)) body: z.output<typeof dashboardIpRuleSchema>) {
    return this.dashboardIp.add(actor, body);
  }

  @Delete('dashboard-ip/:ruleId')
  @RequirePermissions('user.manage')
  @RequireStepUp()
  @ApiOperation({ summary: 'Remove an entry (removing the last one opens sign-in from anywhere)' })
  remove(@CurrentActor() actor: Actor, @Param('ruleId', new ZodValidationPipe(idSchema('dip'))) id: string) {
    return this.dashboardIp.remove(actor, id);
  }
}
