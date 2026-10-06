import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@pay2all/database';
import {
  approveMerchantSchema,
  bankAccountVerificationSchema,
  complianceDecisionSchema,
  idSchema,
  merchantSettingsSchema,
  screeningUpdateSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PRISMA } from '../../infra/tokens';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { ComplianceService } from './compliance.service';
import { MerchantAccessService } from './merchant-access.service';
import { presentReview } from './merchant.presenter';
import { merchantIdPipe } from './merchants.controller';

const decisionPipe = new ZodValidationPipe(complianceDecisionSchema);
type Decision = z.output<typeof complianceDecisionSchema>;

@ApiTags('Compliance')
@ApiBearerAuth()
@Controller('v1/merchants/:merchantId')
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly access: MerchantAccessService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  @Post('submit')
  @HttpCode(200)
  @RequirePermissions('merchant.update')
  @ApiOperation({ summary: 'Submit the application for compliance review (fails with the list of missing items)' })
  submit(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string) {
    return this.compliance.submit(actor, id);
  }

  @Get('reviews')
  @RequirePermissions('compliance.read')
  @ApiOperation({ summary: 'Append-only compliance history' })
  async reviews(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string) {
    await this.access.require(actor, id);
    const rows = await this.prisma.complianceReview.findMany({ where: { merchantId: id }, orderBy: { reviewedAt: 'desc' }, take: 200 });
    return rows.map(presentReview);
  }

  @Post('review/start')
  @HttpCode(200)
  @RequirePermissions('compliance.approve')
  startReview(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string) {
    return this.compliance.startReview(actor, id);
  }

  @Post('review/request-information')
  @HttpCode(200)
  @RequirePermissions('compliance.approve')
  @ApiZodBody(complianceDecisionSchema)
  requestInformation(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(decisionPipe) body: Decision) {
    return this.compliance.requestInformation(actor, id, body);
  }

  @Post('review/approve')
  @HttpCode(200)
  @RequirePermissions('merchant.approve')
  @ApiOperation({ summary: 'Approve (requires verified documents, verified bank account and cleared screening)' })
  @ApiZodBody(approveMerchantSchema)
  approve(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(new ZodValidationPipe(approveMerchantSchema)) body: z.output<typeof approveMerchantSchema>) {
    return this.compliance.approve(actor, id, body);
  }

  @Post('review/reject')
  @HttpCode(200)
  @RequirePermissions('merchant.approve')
  @ApiZodBody(complianceDecisionSchema)
  reject(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(decisionPipe) body: Decision) {
    return this.compliance.reject(actor, id, body);
  }

  @Post('suspend')
  @HttpCode(200)
  @RequirePermissions('merchant.suspend')
  @ApiZodBody(complianceDecisionSchema)
  suspend(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(decisionPipe) body: Decision) {
    return this.compliance.suspend(actor, id, body);
  }

  @Post('reactivate')
  @HttpCode(200)
  @RequirePermissions('merchant.suspend')
  @ApiZodBody(complianceDecisionSchema)
  reactivate(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(decisionPipe) body: Decision) {
    return this.compliance.reactivate(actor, id, body);
  }

  @Patch('screening')
  @RequirePermissions('compliance.approve')
  @ApiZodBody(screeningUpdateSchema)
  screening(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(new ZodValidationPipe(screeningUpdateSchema)) body: z.output<typeof screeningUpdateSchema>) {
    return this.compliance.updateScreening(actor, id, body);
  }

  @Post('bank-accounts/:accountId/verification')
  @HttpCode(200)
  @RequirePermissions('compliance.approve')
  @ApiZodBody(bankAccountVerificationSchema)
  verifyBank(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) id: string,
    @Param('accountId', new ZodValidationPipe(idSchema('mba'))) accountId: string,
    @Body(new ZodValidationPipe(bankAccountVerificationSchema)) body: z.output<typeof bankAccountVerificationSchema>,
  ) {
    return this.compliance.verifyBankAccount(actor, id, accountId, body);
  }

  @Patch('settings')
  @RequirePermissions('merchant.approve')
  @ApiOperation({ summary: 'Enable/disable payin & payout and set risk category (audited, reason required)' })
  @ApiZodBody(merchantSettingsSchema)
  settings(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) id: string, @Body(new ZodValidationPipe(merchantSettingsSchema)) body: z.output<typeof merchantSettingsSchema>) {
    return this.compliance.updateSettings(actor, id, body);
  }
}
