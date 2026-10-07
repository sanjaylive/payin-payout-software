import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createReportExportSchema, listReportExportsQuerySchema, reportExportIdSchema } from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { ReportsService } from './reports.service';

const exportId = new ZodValidationPipe(reportExportIdSchema);

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('v1/reports/exports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @RequirePermissions('report.export')
  @ApiOperation({ summary: 'Request an asynchronous export (CSV). Generated in the background; poll the export, then download.' })
  @ApiZodBody(createReportExportSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createReportExportSchema)) body: z.output<typeof createReportExportSchema>) {
    return this.reports.create(actor, body);
  }

  @Get()
  @RequirePermissions('report.read')
  @ApiZodQuery(listReportExportsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listReportExportsQuerySchema)) q: z.output<typeof listReportExportsQuerySchema>) {
    return this.reports.list(actor, q);
  }

  @Get(':id')
  @RequirePermissions('report.read')
  get(@CurrentActor() actor: Actor, @Param('id', exportId) id: string) {
    return this.reports.get(actor, id);
  }

  @Get(':id/download')
  @RequirePermissions('report.export')
  @ApiOperation({ summary: 'Download a completed export (streams the file; audited)' })
  async download(@CurrentActor() actor: Actor, @Param('id', exportId) id: string, @Res() res: Response) {
    await this.reports.download(actor, id, res);
  }
}
