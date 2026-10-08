import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { generateInvoicesSchema, invoiceIdSchema, listInvoicesQuerySchema, taxProfileSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequireAnyPermission, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller('v1/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'Monthly GST tax invoices for platform fees' })
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listInvoicesQuerySchema)) q: z.output<typeof listInvoicesQuerySchema>) {
    return this.invoices.list(actor, q);
  }

  @Get(':id')
  @RequirePermissions('report.read')
  get(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(invoiceIdSchema)) id: string) {
    return this.invoices.get(actor, id);
  }
}

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller('v1/admin')
export class AdminInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('tax-profile')
  @RequireAnyPermission('system.settings.manage', 'settlement.process')
  @ApiOperation({ summary: 'The platform GST registration printed on invoices' })
  taxProfile() {
    return this.invoices.taxProfile();
  }

  @Put('tax-profile')
  @RequireStepUp()
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(taxProfileSchema)
  saveTaxProfile(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(taxProfileSchema)) body: z.output<typeof taxProfileSchema>) {
    return this.invoices.saveTaxProfile(actor, body);
  }

  @Post('invoices/generate')
  @HttpCode(200)
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Issue a past month’s invoices now (idempotent; the monthly job does this automatically)' })
  @ApiZodBody(generateInvoicesSchema)
  generate(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(generateInvoicesSchema)) body: z.output<typeof generateInvoicesSchema>) {
    return this.invoices.generateAs(actor, body.month, body.merchant_id);
  }
}
