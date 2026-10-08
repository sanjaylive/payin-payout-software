import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { collectionAccountSchema, createFundRequestSchema, decideFundRequestSchema, idSchema, listFundRequestsQuerySchema } from '@pay2all/validation';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { FundsService } from './funds.service';
import { StatementsService } from './statements.service';

const accountId = new ZodValidationPipe(idSchema('cac'));
const requestId = new ZodValidationPipe(idSchema('fnd'));
const reasonSchema = z.strictObject({ reason: z.string().trim().min(5).max(300) });
const updateAccountSchema = collectionAccountSchema.and(z.object({ version: z.number().int().min(1).optional() }));

@ApiTags('Wallet funds')
@ApiBearerAuth()
@Controller('v1/funds')
export class FundsController {
  constructor(private readonly funds: FundsService) {}

  // Collection accounts (super admins).

  @Get('accounts')
  @RequirePermissions('fund.read')
  @ApiOperation({ summary: 'Platform: every collection account with usage. Merchant: active accounts to pay into.' })
  accounts(@CurrentActor() actor: Actor) {
    return actor.organizationType === 'PLATFORM' ? this.funds.listAccounts(actor) : this.funds.accountsForMerchant(actor);
  }

  @Post('accounts')
  @RequireStepUp()
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(collectionAccountSchema)
  createAccount(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(collectionAccountSchema)) body: z.output<typeof collectionAccountSchema>) {
    return this.funds.createAccount(actor, body);
  }

  @Put('accounts/:id')
  @RequireStepUp()
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(collectionAccountSchema)
  updateAccount(@CurrentActor() actor: Actor, @Param('id', accountId) id: string, @Body(new ZodValidationPipe(updateAccountSchema)) body: z.output<typeof updateAccountSchema>) {
    return this.funds.updateAccount(actor, id, body);
  }

  @Post('accounts/:id/remove')
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(reasonSchema)
  removeAccount(@CurrentActor() actor: Actor, @Param('id', accountId) id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.output<typeof reasonSchema>) {
    return this.funds.removeAccount(actor, id, body.reason);
  }

  // Fund requests.

  @Get('requests')
  @RequirePermissions('fund.read')
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listFundRequestsQuerySchema)) q: z.output<typeof listFundRequestsQuerySchema>) {
    return this.funds.list(actor, q);
  }

  @Get('summary')
  @RequirePermissions('fund.read')
  summary(@CurrentActor() actor: Actor) {
    return this.funds.summary(actor);
  }

  @Post('requests')
  @RequirePermissions('fund.request')
  @ApiOperation({ summary: 'After paying into a collection account, submit the amount and UTR for approval' })
  @ApiZodBody(createFundRequestSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createFundRequestSchema)) body: z.output<typeof createFundRequestSchema>) {
    return this.funds.create(actor, body);
  }

  @Get('requests/:id')
  @RequirePermissions('fund.read')
  get(@CurrentActor() actor: Actor, @Param('id', requestId) id: string) {
    return this.funds.get(actor, id);
  }

  @Post('requests/:id/proof')
  @RequirePermissions('fund.request')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a payment screenshot or PDF (while pending)' })
  uploadProof(@CurrentActor() actor: Actor, @Param('id', requestId) id: string, @UploadedFile() file: { buffer: Buffer; size: number; originalname: string } | undefined) {
    return this.funds.uploadProof(actor, id, file);
  }

  @Get('requests/:id/proof')
  @RequirePermissions('fund.read')
  async proof(@CurrentActor() actor: Actor, @Param('id', requestId) id: string, @Res() res: Response) {
    const p = await this.funds.proof(actor, id);
    res.setHeader('Content-Type', p.type);
    res.setHeader('Content-Disposition', `inline; filename="${p.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    p.stream.pipe(res);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('fund.request')
  cancel(@CurrentActor() actor: Actor, @Param('id', requestId) id: string) {
    return this.funds.cancel(actor, id);
  }

  @Post('requests/:id/decision')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('fund.approve')
  @ApiOperation({ summary: 'Approve (credits the merchant wallet) or reject a fund request' })
  @ApiZodBody(decideFundRequestSchema)
  decide(@CurrentActor() actor: Actor, @Param('id', requestId) id: string, @Body(new ZodValidationPipe(decideFundRequestSchema)) body: z.output<typeof decideFundRequestSchema>) {
    return this.funds.decide(actor, id, body);
  }
}

/** Bank statement import and automatic matching (docs/FUND_REQUESTS.md §6). Platform approvers only. */
@ApiTags('Wallet funds')
@ApiBearerAuth()
@Controller('v1/funds/statements')
export class StatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Post(':accountId')
  @RequireStepUp()
  @RequirePermissions('fund.approve')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import a collection account’s bank statement (CSV); matching credits approve their fund requests' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0 } }))
  import(@CurrentActor() actor: Actor, @Param('accountId', accountId) id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.statements.import(actor, id, file);
  }

  @Get()
  @RequirePermissions('fund.approve')
  @ApiOperation({ summary: 'Recent statement imports' })
  list(@CurrentActor() actor: Actor) {
    return this.statements.list(actor);
  }

  @Get(':importId')
  @RequirePermissions('fund.approve')
  @ApiOperation({ summary: 'One import with every credit and how it was matched' })
  get(@CurrentActor() actor: Actor, @Param('importId', new ZodValidationPipe(idSchema('sti'))) id: string) {
    return this.statements.get(actor, id);
  }
}
