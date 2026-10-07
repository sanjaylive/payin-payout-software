import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { listLoginEventsQuerySchema, loginEventsExportSchema } from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { ReportsService } from '../reports/reports.service';
import { LoginEventsService } from './login-events.service';

@ApiTags('Login activity')
@ApiBearerAuth()
@Controller('v1/login-events')
export class LoginEventsController {
  constructor(
    private readonly events: LoginEventsService,
    private readonly reports: ReportsService,
  ) {}

  @Get()
  @RequirePermissions('user.read')
  @ApiOperation({ summary: 'Sign-in attempts with outcome, IP, device and (when shared) browser location' })
  @ApiZodQuery(listLoginEventsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listLoginEventsQuerySchema)) q: z.output<typeof listLoginEventsQuerySchema>) {
    return this.events.list(actor, q);
  }

  @Get('summary')
  @RequirePermissions('user.read')
  @ApiZodQuery(listLoginEventsQuerySchema)
  summary(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listLoginEventsQuerySchema)) q: z.output<typeof listLoginEventsQuerySchema>) {
    return this.events.summary(actor, q);
  }

  @Get('export.csv')
  @RequirePermissions('user.read', 'report.export')
  @ApiOperation({ summary: 'Download sign-ins as CSV (up to 10,000 rows; audited)' })
  @ApiZodQuery(loginEventsExportSchema)
  async exportCsv(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(loginEventsExportSchema)) q: z.output<typeof loginEventsExportSchema>, @Res() res: Response) {
    await this.events.exportCsv(actor, q, res);
  }

  @Post('export-email')
  @HttpCode(202)
  @RequirePermissions('user.read', 'report.export')
  @ApiOperation({ summary: 'Generate in the background and email the requester a sign-in-protected download link' })
  @ApiZodBody(loginEventsExportSchema)
  exportEmail(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(loginEventsExportSchema)) body: z.output<typeof loginEventsExportSchema>) {
    return this.reports.create(actor, { type: 'LOGIN_EVENTS', format: 'CSV', from: body.from, to: body.to, notify_by_email: true, ...(body.organization_id ? { merchant_id: body.organization_id } : {}) });
  }
}
