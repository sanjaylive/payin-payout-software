import { Controller, Get, Query } from '@nestjs/common';
import { analyticsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { AnalyticsService } from './analytics.service';

@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Also needs payin.read or payout.read for the requested kind (checked in the service). */
  @Get()
  @RequirePermissions('report.read')
  overview(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(analyticsQuerySchema)) q: z.output<typeof analyticsQuerySchema>) {
    return this.analytics.overview(actor, q);
  }
}
