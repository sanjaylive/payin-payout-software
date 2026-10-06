import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assignRoleSchema, createUserSchema, idSchema, listUsersQuerySchema, updateUserStatusSchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { UsersService } from './users.service';

const userIdPipe = new ZodValidationPipe(idSchema('usr'));
const roleKeyPipe = new ZodValidationPipe(z.string().regex(/^[A-Z_]{3,40}$/));
const revokeQuerySchema = z.strictObject({ organization_id: idSchema('org').optional() });

@ApiTags('Users')
@ApiBearerAuth()
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: 'Invite a user to an organization with a role' })
  @ApiZodBody(createUserSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createUserSchema)) body: z.output<typeof createUserSchema>) {
    return this.users.create(actor, body);
  }

  @Patch(':id/status')
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

  @Post(':id/roles')
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
