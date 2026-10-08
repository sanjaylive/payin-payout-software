import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assignRoleSchema, createUserSchema, idSchema, listUsersQuerySchema, updateUserStatusSchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { MfaService } from '../auth/mfa.service';
import { UsersService } from './users.service';

const userIdPipe = new ZodValidationPipe(idSchema('usr'));
const roleKeyPipe = new ZodValidationPipe(z.string().regex(/^[A-Z_]{3,40}$/));
const revokeQuerySchema = z.strictObject({ organization_id: idSchema('org').optional() });
const mfaResetSchema = z.strictObject({ reason: z.string().trim().min(5).max(500) });

@ApiTags('Users')
@ApiBearerAuth()
@Controller('v1/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  @RequirePermissions('user.read')
  @ApiZodQuery(listUsersQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: z.output<typeof listUsersQuerySchema>,
  ) {
    return this.users.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions('user.read')
  get(@CurrentActor() actor: Actor, @Param('id', userIdPipe) id: string) {
    return this.users.get(actor, id);
  }

  @Post()
  @RequireStepUp()
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Invite a user to an organization with a role' })
  @ApiZodBody(createUserSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createUserSchema)) body: z.output<typeof createUserSchema>) {
    return this.users.create(actor, body);
  }

  @Patch(':id/status')
  @RequireStepUp()
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Enable/disable a user account globally (platform staff only)' })
  @ApiZodBody(updateUserStatusSchema)
  updateStatus(
    @CurrentActor() actor: Actor,
    @Param('id', userIdPipe) id: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) body: z.output<typeof updateUserStatusSchema>,
  ) {
    return this.users.updateStatus(actor, id, body);
  }

  @Post(':id/mfa/reset')
  @RequireStepUp()
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Reset a user\'s two-factor authentication (platform staff; audited; signs the user out)' })
  @ApiZodBody(mfaResetSchema)
  async resetMfa(
    @CurrentActor() actor: Actor,
    @Param('id', userIdPipe) id: string,
    @Body(new ZodValidationPipe(mfaResetSchema)) body: z.output<typeof mfaResetSchema>,
  ) {
    await this.users.get(actor, id); // scope check (404 outside scope)
    await this.mfa.adminReset(actor, id, body.reason);
    return { mfa_reset: true };
  }

  @Post(':id/roles')
  @RequireStepUp()
  @RequirePermissions('user.manage')
  @ApiZodBody(assignRoleSchema)
  assignRole(
    @CurrentActor() actor: Actor,
    @Param('id', userIdPipe) id: string,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: z.output<typeof assignRoleSchema>,
  ) {
    return this.users.assignRole(actor, id, body);
  }

  @Delete(':id/roles/:roleKey')
  @RequirePermissions('user.manage')
  revokeRole(
    @CurrentActor() actor: Actor,
    @Param('id', userIdPipe) id: string,
    @Param('roleKey', roleKeyPipe) roleKey: string,
    @Query(new ZodValidationPipe(revokeQuerySchema)) query: z.output<typeof revokeQuerySchema>,
  ) {
    return this.users.revokeRole(actor, id, roleKey, query.organization_id);
  }
}
