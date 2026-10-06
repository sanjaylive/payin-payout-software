import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { convertLeadSchema, createLeadSchema, idSchema, listLeadsQuerySchema, salesAssignmentSchema, updateLeadSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { SalesService } from './sales.service';

const leadIdPipe = new ZodValidationPipe(idSchema('lead'));

@ApiTags('Sales')
@ApiBearerAuth()
@Controller('v1')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('sales/leads')
  @RequirePermissions('sales.read')
  @ApiZodQuery(listLeadsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listLeadsQuerySchema)) q: z.output<typeof listLeadsQuerySchema>) {
    return this.sales.list(actor, q);
  }

  @Get('sales/users')
  @RequirePermissions('sales.read')
  @ApiOperation({ summary: 'Platform users who can own sales relationships' })
  users() {
    return this.sales.salesUsers();
  }

  @Get('sales/leads/:id')
  @RequirePermissions('sales.read')
  get(@Param('id', leadIdPipe) id: string) {
    return this.sales.get(id);
  }

  @Post('sales/leads')
  @RequirePermissions('sales.manage')
  @ApiZodBody(createLeadSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createLeadSchema)) body: z.output<typeof createLeadSchema>) {
    return this.sales.create(actor, body);
  }

  @Patch('sales/leads/:id')
  @RequirePermissions('sales.manage')
  @ApiZodBody(updateLeadSchema)
  update(@CurrentActor() actor: Actor, @Param('id', leadIdPipe) id: string, @Body(new ZodValidationPipe(updateLeadSchema)) body: z.output<typeof updateLeadSchema>) {
    return this.sales.update(actor, id, body);
  }

  @Post('sales/leads/:id/convert')
  @HttpCode(200)
  @RequirePermissions('sales.manage', 'merchant.create')
  @ApiOperation({ summary: 'Convert a lead into a DRAFT merchant' })
  @ApiZodBody(convertLeadSchema)
  convert(@CurrentActor() actor: Actor, @Param('id', leadIdPipe) id: string, @Body(new ZodValidationPipe(convertLeadSchema)) body: z.output<typeof convertLeadSchema>) {
    return this.sales.convert(actor, id, body);
  }

  @Patch('organizations/:id/sales-assignment')
  @RequirePermissions('sales.manage')
  @ApiZodBody(salesAssignmentSchema)
  assign(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(idSchema('org'))) id: string,
    @Body(new ZodValidationPipe(salesAssignmentSchema)) body: z.output<typeof salesAssignmentSchema>,
  ) {
    return this.sales.assign(actor, id, body);
  }
}
