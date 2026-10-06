import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createOrganizationSchema, idSchema, listOrganizationsQuerySchema, updateOrganizationStatusSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { OrganizationsService } from './organizations.service';

const orgIdPipe = new ZodValidationPipe(idSchema('org'));

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('v1/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @RequirePermissions('organization.read')
  @ApiOperation({ summary: 'List organizations visible to the caller' })
  @ApiZodQuery(listOrganizationsQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listOrganizationsQuerySchema)) query: z.output<typeof listOrganizationsQuerySchema>,
  ) {
    return this.organizations.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions('organization.read')
  get(@CurrentActor() actor: Actor, @Param('id', orgIdPipe) id: string) {
    return this.organizations.get(actor, id);
  }

  @Post()
  @RequirePermissions('organization.manage')
  @ApiOperation({ summary: 'Create a reseller, API partner or merchant organization (platform staff)' })
  @ApiZodBody(createOrganizationSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: z.output<typeof createOrganizationSchema>,
  ) {
    return this.organizations.create(actor, body);
  }

  @Patch(':id/status')
  @RequirePermissions('organization.manage')
  @ApiOperation({ summary: 'Suspend, reactivate or close an organization (audited, reason required)' })
  @ApiZodBody(updateOrganizationStatusSchema)
  updateStatus(
    @CurrentActor() actor: Actor,
    @Param('id', orgIdPipe) id: string,
    @Body(new ZodValidationPipe(updateOrganizationStatusSchema)) body: z.output<typeof updateOrganizationStatusSchema>,
  ) {
    return this.organizations.updateStatus(actor, id, body);
  }
}
