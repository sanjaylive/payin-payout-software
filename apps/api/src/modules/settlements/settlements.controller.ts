import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorCode } from '@pay2all/types';
import {
  idSchema,
  listSettlementsQuerySchema,
  markSettlementFailedSchema,
  markSettlementPaidSchema,
  providerRemittanceSchema,
  releaseHoldSchema,
  settlementConfigSchema,
  settlementHoldSchema,
} from '@pay2all/validation';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { SettlementsService } from './settlements.service';

const stlId = new ZodValidationPipe(idSchema('stl'));
const orgId = new ZodValidationPipe(idSchema('org'));
const platformOnly = (actor: Actor) => {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
};

function sendCsv(res: Response, file: { filename: string; csv: string }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.csv);
}

@ApiTags('Settlements')
@ApiBearerAuth()
@Controller('v1/settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  @ApiKeyAccess()
  @RequirePermissions('settlement.read')
  @ApiZodQuery(listSettlementsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listSettlementsQuerySchema)) q: z.output<typeof listSettlementsQuerySchema>) {
    return this.settlements.list(actor, q);
  }

  @Get('config/:merchantId')
  @RequirePermissions('settlement.read')
  config(@CurrentActor() actor: Actor, @Param('merchantId', orgId) merchantId: string) {
    return this.settlements.getConfig(actor, merchantId);
  }

  @Put('config/:merchantId')
  @RequireStepUp()
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Platform: set a merchant’s settlement cycle, cutoff, minimum and destination' })
  @ApiZodBody(settlementConfigSchema)
  updateConfig(@CurrentActor() actor: Actor, @Param('merchantId', orgId) merchantId: string, @Body(new ZodValidationPipe(settlementConfigSchema)) body: z.output<typeof settlementConfigSchema>) {
    platformOnly(actor);
    return this.settlements.updateConfig(actor, merchantId, body);
  }

  @Post('run')
  @HttpCode(200)
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Platform: generate due settlements now (same rules as the scheduled job)' })
  run(@CurrentActor() actor: Actor, @Query('merchant_id') merchantId?: string) {
    platformOnly(actor);
    if (merchantId) {
      const id = orgId.transform(merchantId);
      return this.settlements.generateFor(id, new Date(), { manual: true, actorId: actor.userId }).then((r) => [{ ...r, netMinor: undefined, net: 'netMinor' in r ? String(r.netMinor) : undefined }]);
    }
    return this.settlements.generateDue().then((rs) => rs.map((r) => ({ ...r, netMinor: undefined, net: 'netMinor' in r ? String(r.netMinor) : undefined })));
  }

  @Get('transfer-file')
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Platform finance: bank transfer instructions for settlements in progress (audited; MFA session)' })
  async transferFile(@CurrentActor() actor: Actor, @Res() res: Response) {
    platformOnly(actor);
    sendCsv(res, await this.settlements.transferFile(actor));
  }

  @Get('holds')
  @RequirePermissions('settlement.read')
  holds(@CurrentActor() actor: Actor, @Query('active') active?: string) {
    platformOnly(actor);
    return this.settlements.listHolds(active !== 'false');
  }

  @Post('holds')
  @RequirePermissions('settlement.hold')
  @ApiZodBody(settlementHoldSchema)
  placeHold(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(settlementHoldSchema)) body: z.output<typeof settlementHoldSchema>) {
    platformOnly(actor);
    return this.settlements.placeHold(actor, body.merchant_id, body.reason);
  }

  @Post('holds/:id/release')
  @HttpCode(200)
  @RequirePermissions('settlement.hold')
  @ApiZodBody(releaseHoldSchema)
  releaseHold(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('sth'))) id: string, @Body(new ZodValidationPipe(releaseHoldSchema)) body: z.output<typeof releaseHoldSchema>) {
    platformOnly(actor);
    return this.settlements.releaseHold(actor, id, body.reason);
  }

  @Get('remittances')
  @RequirePermissions('settlement.process')
  remittances(@CurrentActor() actor: Actor) {
    platformOnly(actor);
    return this.settlements.listRemittances();
  }

  @Post('remittances')
  @RequirePermissions('settlement.process')
  @ApiOperation({ summary: 'Platform finance: record a provider remittance (posts PROVIDER_SETTLEMENT)' })
  @ApiZodBody(providerRemittanceSchema)
  recordRemittance(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(providerRemittanceSchema)) body: z.output<typeof providerRemittanceSchema>) {
    platformOnly(actor);
    return this.settlements.recordRemittance(actor, body);
  }

  @Get('fees/:merchantId')
  @RequirePermissions('ledger.read')
  @ApiOperation({ summary: 'Fees and GST charged in a month (IST)' })
  fees(@CurrentActor() actor: Actor, @Param('merchantId', orgId) merchantId: string, @Query('month') month?: string) {
    const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    return this.settlements.feeSummary(actor, merchantId, m);
  }

  @Get(':id')
  @ApiKeyAccess()
  @RequirePermissions('settlement.read')
  get(@CurrentActor() actor: Actor, @Param('id', stlId) id: string) {
    return this.settlements.get(actor, id);
  }

  @Get(':id/statement')
  @RequirePermissions('settlement.read')
  async statement(@CurrentActor() actor: Actor, @Param('id', stlId) id: string, @Res() res: Response) {
    sendCsv(res, await this.settlements.statementCsv(actor, id));
  }

  @Post(':id/paid')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('settlement.process')
  @ApiZodBody(markSettlementPaidSchema)
  paid(@CurrentActor() actor: Actor, @Param('id', stlId) id: string, @Body(new ZodValidationPipe(markSettlementPaidSchema)) body: z.output<typeof markSettlementPaidSchema>) {
    platformOnly(actor);
    return this.settlements.markPaid(actor, id, body);
  }

  @Post(':id/failed')
  @HttpCode(200)
  @RequirePermissions('settlement.process')
  @ApiZodBody(markSettlementFailedSchema)
  failed(@CurrentActor() actor: Actor, @Param('id', stlId) id: string, @Body(new ZodValidationPipe(markSettlementFailedSchema)) body: z.output<typeof markSettlementFailedSchema>) {
    platformOnly(actor);
    return this.settlements.markFailed(actor, id, body.reason);
  }
}
