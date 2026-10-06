import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  blockBeneficiarySchema,
  createBeneficiarySchema,
  createPayoutSchema,
  idSchema,
  listBeneficiariesQuerySchema,
  listPayoutsQuerySchema,
  paymentStatsQuerySchema,
  payoutDecisionSchema,
  payoutRejectSchema,
  resolvePayoutReviewSchema,
} from '@pay2all/validation';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, RequireAnyPermission, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { BeneficiariesService } from './beneficiaries.service';
import { BULK_MAX_BYTES, BulkPayoutsService } from './bulk-payouts.service';
import { PayoutsService } from './payouts.service';

const payoutIdPipe = new ZodValidationPipe(idSchema('pout'));
const beneficiaryIdPipe = new ZodValidationPipe(idSchema('ben'));
const batchIdPipe = new ZodValidationPipe(idSchema('bpb'));

@ApiTags('Payouts')
@ApiBearerAuth()
@Controller('v1')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly bulk: BulkPayoutsService,
  ) {}

  @Post('payouts')
  @ApiKeyAccess()
  @HttpCode(202)
  @RequirePermissions('payout.create')
  @ApiOperation({ summary: 'Create a payout. Funds are reserved immediately; completion is asynchronous. Idempotent per Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiZodBody(createPayoutSchema)
  create(@CurrentActor() actor: Actor, @Body() raw: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.payouts.create(actor, new ZodValidationPipe(createPayoutSchema).transform(raw), raw, key);
  }

  @Get('payouts')
  @ApiKeyAccess()
  @RequirePermissions('payout.read')
  @ApiZodQuery(listPayoutsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listPayoutsQuerySchema)) q: z.output<typeof listPayoutsQuerySchema>) {
    return this.payouts.list(actor, q);
  }

  @Get('payouts/stats')
  @ApiKeyAccess()
  @RequirePermissions('payout.read')
  @ApiZodQuery(paymentStatsQuerySchema)
  stats(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(paymentStatsQuerySchema)) q: z.output<typeof paymentStatsQuerySchema>) {
    return this.payouts.stats(actor, q);
  }

  // ---- Bulk (declared before :id routes) ----

  @Get('payouts/bulk')
  @RequirePermissions('payout.read')
  listBatches(@CurrentActor() actor: Actor) {
    return this.bulk.list(actor);
  }

  @Post('payouts/bulk')
  @RequirePermissions('payout.create')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: BULK_MAX_BYTES + 1, files: 1, fields: 2 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a bulk payout CSV (≤ 1,000 rows, ≤ 1 MB). Validated immediately; the file itself is not stored.' })
  upload(@CurrentActor() actor: Actor, @UploadedFile() file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    return this.bulk.upload(actor, file);
  }

  @Get('payouts/bulk/:id')
  @RequirePermissions('payout.read')
  getBatch(@CurrentActor() actor: Actor, @Param('id', batchIdPipe) id: string) {
    return this.bulk.get(actor, id);
  }

  @Post('payouts/bulk/:id/confirm')
  @HttpCode(200)
  @RequirePermissions('payout.create')
  @ApiOperation({ summary: 'Confirm a validated batch (maker, MFA session). Rows are then created as payouts.' })
  confirm(@CurrentActor() actor: Actor, @Param('id', batchIdPipe) id: string) {
    return this.bulk.confirm(actor, id);
  }

  @Post('payouts/bulk/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('payout.create')
  cancelBatch(@CurrentActor() actor: Actor, @Param('id', batchIdPipe) id: string) {
    return this.bulk.cancel(actor, id);
  }

  @Post('payouts/bulk/:id/approve')
  @HttpCode(200)
  @RequirePermissions('payout.approve')
  @ApiOperation({ summary: 'Approve every payout of the batch you can still vote on' })
  approveBatch(@CurrentActor() actor: Actor, @Param('id', batchIdPipe) id: string, @Body(new ZodValidationPipe(payoutDecisionSchema)) body: z.output<typeof payoutDecisionSchema>) {
    return this.bulk.decideAll(actor, id, 'APPROVE', body.reason);
  }

  @Post('payouts/bulk/:id/reject')
  @HttpCode(200)
  @RequirePermissions('payout.approve')
  rejectBatch(@CurrentActor() actor: Actor, @Param('id', batchIdPipe) id: string, @Body(new ZodValidationPipe(payoutRejectSchema)) body: z.output<typeof payoutRejectSchema>) {
    return this.bulk.decideAll(actor, id, 'REJECT', body.reason);
  }

  // ---- Single payout ----

  @Get('payouts/:id')
  @ApiKeyAccess()
  @RequirePermissions('payout.read')
  get(@CurrentActor() actor: Actor, @Param('id', payoutIdPipe) id: string) {
    return this.payouts.get(actor, id);
  }

  @Post('payouts/:id/approve')
  @HttpCode(200)
  @RequirePermissions('payout.approve')
  @ApiOperation({ summary: 'Approve a payout (checker; not the maker; MFA-verified session)' })
  @ApiZodBody(payoutDecisionSchema)
  approve(@CurrentActor() actor: Actor, @Param('id', payoutIdPipe) id: string, @Body(new ZodValidationPipe(payoutDecisionSchema)) body: z.output<typeof payoutDecisionSchema>) {
    return this.payouts.approve(actor, id, body.reason);
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  @RequireAnyPermission('payout.approve', 'payout.create')
  @ApiOperation({ summary: 'Reject (checker) or cancel (maker) a payout awaiting approval; releases the reserved funds' })
  @ApiZodBody(payoutRejectSchema)
  reject(@CurrentActor() actor: Actor, @Param('id', payoutIdPipe) id: string, @Body(new ZodValidationPipe(payoutRejectSchema)) body: z.output<typeof payoutRejectSchema>) {
    return this.payouts.reject(actor, id, body.reason);
  }

  @Post('payouts/:id/review/resolve')
  @HttpCode(200)
  @RequirePermissions('payout.review')
  @ApiOperation({ summary: 'Platform: resolve a payout with an unknown outcome, with bank/provider evidence' })
  @ApiZodBody(resolvePayoutReviewSchema)
  resolve(@CurrentActor() actor: Actor, @Param('id', payoutIdPipe) id: string, @Body(new ZodValidationPipe(resolvePayoutReviewSchema)) body: z.output<typeof resolvePayoutReviewSchema>) {
    return this.payouts.resolveReview(actor, id, body);
  }
}

@ApiTags('Beneficiaries')
@ApiBearerAuth()
@Controller('v1/beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Post()
  @ApiKeyAccess()
  @RequirePermissions('beneficiary.manage')
  @ApiZodBody(createBeneficiarySchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createBeneficiarySchema)) body: z.output<typeof createBeneficiarySchema>) {
    return this.beneficiaries.create(actor, body);
  }

  @Get()
  @ApiKeyAccess()
  @RequirePermissions('beneficiary.read')
  @ApiZodQuery(listBeneficiariesQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listBeneficiariesQuerySchema)) q: z.output<typeof listBeneficiariesQuerySchema>) {
    return this.beneficiaries.list(actor, q);
  }

  @Get(':id')
  @ApiKeyAccess()
  @RequirePermissions('beneficiary.read')
  get(@CurrentActor() actor: Actor, @Param('id', beneficiaryIdPipe) id: string) {
    return this.beneficiaries.get(actor, id);
  }

  @Post(':id/verify')
  @ApiKeyAccess()
  @HttpCode(200)
  @RequirePermissions('beneficiary.manage')
  @ApiOperation({ summary: 'Verify via penny-drop / VPA lookup and compare the bank-registered name' })
  verify(@CurrentActor() actor: Actor, @Param('id', beneficiaryIdPipe) id: string) {
    return this.beneficiaries.verify(actor, id);
  }

  @Post(':id/block')
  @HttpCode(200)
  @RequireAnyPermission('beneficiary.manage', 'payout.review')
  @ApiZodBody(blockBeneficiarySchema)
  block(@CurrentActor() actor: Actor, @Param('id', beneficiaryIdPipe) id: string, @Body(new ZodValidationPipe(blockBeneficiarySchema)) body: z.output<typeof blockBeneficiarySchema>) {
    return this.beneficiaries.block(actor, id, body.reason);
  }
}
