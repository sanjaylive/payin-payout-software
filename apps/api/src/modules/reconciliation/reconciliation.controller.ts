import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { idSchema, listReconEntriesQuerySchema, reconUploadSchema, resolveReconEntrySchema } from '@pay2all/validation';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { RECON_MAX_BYTES, ReconciliationService } from './reconciliation.service';

const runId = new ZodValidationPipe(idSchema('rcn'));

@ApiTags('Reconciliation')
@ApiBearerAuth()
@Controller('v1/reconciliation')
export class ReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  @Post('runs')
  @RequirePermissions('reconciliation.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: RECON_MAX_BYTES + 1, files: 1, fields: 4 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import a provider statement (CSV). Matching runs in the background.' })
  upload(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(reconUploadSchema)) body: z.output<typeof reconUploadSchema>, @UploadedFile() file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    return this.recon.upload(actor, body, file);
  }

  @Get('runs')
  @RequirePermissions('reconciliation.read')
  runs() {
    return this.recon.listRuns();
  }

  @Get('runs/:id')
  @RequirePermissions('reconciliation.read')
  run(@Param('id', runId) id: string) {
    return this.recon.getRun(id);
  }

  @Get('runs/:id/entries')
  @RequirePermissions('reconciliation.read')
  @ApiZodQuery(listReconEntriesQuerySchema)
  entries(@Param('id', runId) id: string, @Query(new ZodValidationPipe(listReconEntriesQuerySchema)) q: z.output<typeof listReconEntriesQuerySchema>) {
    return this.recon.listEntries(id, q);
  }

  @Post('entries/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('reconciliation.manage')
  @ApiOperation({ summary: 'Resolve a mismatch with a note, or accept a provider-confirmed payment (captures it)' })
  @ApiZodBody(resolveReconEntrySchema)
  resolve(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('rce'))) id: string, @Body(new ZodValidationPipe(resolveReconEntrySchema)) body: z.output<typeof resolveReconEntrySchema>) {
    return this.recon.resolve(actor, id, body);
  }
}
