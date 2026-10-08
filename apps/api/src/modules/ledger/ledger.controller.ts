import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adjustmentDecisionSchema,
  balancesQuerySchema,
  createAdjustmentSchema,
  idSchema,
  listAdjustmentsQuerySchema,
  listJournalsQuerySchema,
  listLedgerAccountsQuerySchema,
  rejectAdjustmentSchema,
  reverseJournalSchema,
  statementQuerySchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, RequireAnyPermission, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { AdjustmentsService } from './adjustments.service';
import { LedgerService } from './ledger.service';

const accountIdPipe = new ZodValidationPipe(idSchema('lacc'));
const journalIdPipe = new ZodValidationPipe(idSchema('jrnl'));
const adjustmentIdPipe = new ZodValidationPipe(idSchema('adj'));

@ApiTags('Ledger')
@ApiBearerAuth()
@Controller('v1/ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  @Get('balances')
  @ApiKeyAccess()
  @RequirePermissions('ledger.read')
  @ApiOperation({ summary: 'Merchant balance buckets (available, pending, unsettled, reserved, lien, settled)' })
  @ApiZodQuery(balancesQuerySchema)
  balances(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(balancesQuerySchema)) q: z.output<typeof balancesQuerySchema>) {
    return this.ledger.balancesFor(actor, q.merchant_id);
  }

  @Get('summary')
  @RequirePermissions('ledger.platform.read')
  @ApiOperation({ summary: 'Platform-wide balance totals (platform staff)' })
  summary() {
    return this.ledger.platformSummary();
  }

  @Get('trial-balance')
  @RequirePermissions('ledger.platform.read')
  trialBalance() {
    return this.ledger.trialBalance();
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermissions('ledger.adjust.approve')
  @ApiOperation({ summary: 'Verify every maintained balance against its entries; drift freezes payouts' })
  verify(@CurrentActor() actor: Actor) {
    return this.ledger.verify(actor);
  }

  @Get('accounts')
  @RequirePermissions('ledger.read')
  @ApiZodQuery(listLedgerAccountsQuerySchema)
  accounts(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listLedgerAccountsQuerySchema)) q: z.output<typeof listLedgerAccountsQuerySchema>) {
    return this.ledger.listAccounts(actor, q);
  }

  @Get('accounts/:id')
  @RequirePermissions('ledger.read')
  account(@CurrentActor() actor: Actor, @Param('id', accountIdPipe) id: string) {
    return this.ledger.getAccount(actor, id);
  }

  @Get('accounts/:id/entries')
  @RequirePermissions('ledger.read')
  @ApiOperation({ summary: 'Account statement with running balance' })
  @ApiZodQuery(statementQuerySchema)
  statement(@CurrentActor() actor: Actor, @Param('id', accountIdPipe) id: string, @Query(new ZodValidationPipe(statementQuerySchema)) q: z.output<typeof statementQuerySchema>) {
    return this.ledger.statement(actor, id, q);
  }

  @Get('journals')
  @RequirePermissions('ledger.read')
  @ApiZodQuery(listJournalsQuerySchema)
  journals(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listJournalsQuerySchema)) q: z.output<typeof listJournalsQuerySchema>) {
    return this.ledger.listJournals(actor, q);
  }

  @Get('journals/:id')
  @RequirePermissions('ledger.read')
  journal(@CurrentActor() actor: Actor, @Param('id', journalIdPipe) id: string) {
    return this.ledger.getJournal(actor, id);
  }

  @Post('journals/:id/reverse')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('ledger.adjust.approve')
  @ApiOperation({ summary: 'Post an exact mirror of a wrong journal (once; never a reversal of a reversal)' })
  @ApiZodBody(reverseJournalSchema)
  reverse(@CurrentActor() actor: Actor, @Param('id', journalIdPipe) id: string, @Body(new ZodValidationPipe(reverseJournalSchema)) body: z.output<typeof reverseJournalSchema>) {
    return this.ledger.reverse(actor, id, body.reason);
  }

  @Get('adjustments')
  @RequireAnyPermission('ledger.adjust', 'ledger.adjust.approve')
  @ApiZodQuery(listAdjustmentsQuerySchema)
  listAdjustments(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listAdjustmentsQuerySchema)) q: z.output<typeof listAdjustmentsQuerySchema>) {
    return this.adjustments.list(actor, q);
  }

  @Get('adjustments/:id')
  @RequireAnyPermission('ledger.adjust', 'ledger.adjust.approve')
  getAdjustment(@CurrentActor() actor: Actor, @Param('id', adjustmentIdPipe) id: string) {
    return this.adjustments.get(actor, id);
  }

  @Post('adjustments')
  @RequireStepUp()
  @RequirePermissions('ledger.adjust')
  @ApiOperation({ summary: 'Raise a manual adjustment (maker). Posted only after independent approval.' })
  @ApiZodBody(createAdjustmentSchema)
  createAdjustment(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createAdjustmentSchema)) body: z.output<typeof createAdjustmentSchema>) {
    return this.adjustments.create(actor, body);
  }

  @Post('adjustments/:id/approve')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('ledger.adjust.approve')
  @ApiZodBody(adjustmentDecisionSchema)
  approve(@CurrentActor() actor: Actor, @Param('id', adjustmentIdPipe) id: string, @Body(new ZodValidationPipe(adjustmentDecisionSchema)) body: z.output<typeof adjustmentDecisionSchema>) {
    return this.adjustments.approve(actor, id, body.comment);
  }

  @Post('adjustments/:id/reject')
  @HttpCode(200)
  @RequireAnyPermission('ledger.adjust', 'ledger.adjust.approve')
  @ApiOperation({ summary: 'Reject (checker) or cancel (maker) a pending adjustment' })
  @ApiZodBody(rejectAdjustmentSchema)
  reject(@CurrentActor() actor: Actor, @Param('id', adjustmentIdPipe) id: string, @Body(new ZodValidationPipe(rejectAdjustmentSchema)) body: z.output<typeof rejectAdjustmentSchema>) {
    return this.adjustments.reject(actor, id, body.reason);
  }
}
