import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { acceptDisputeSchema, disputeEvidenceIdSchema, disputeIdSchema, listDisputesQuerySchema, openDisputeSchema, resolveDisputeSchema, submitDisputeSchema } from '@pay2all/validation';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { DisputesService } from './disputes.service';

const disputeId = new ZodValidationPipe(disputeIdSchema);

@ApiTags('Disputes')
@ApiBearerAuth()
@Controller('v1/disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermissions('dispute.read')
  @ApiOperation({ summary: 'Disputes and chargebacks you can see' })
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listDisputesQuerySchema)) q: z.output<typeof listDisputesQuerySchema>) {
    return this.disputes.list(actor, q);
  }

  @Get('summary')
  @RequirePermissions('dispute.read')
  summary(@CurrentActor() actor: Actor) {
    return this.disputes.summary(actor);
  }

  @Get(':id')
  @RequirePermissions('dispute.read')
  get(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string) {
    return this.disputes.get(actor, id);
  }

  @Get(':id/evidence/:evidenceId')
  @RequirePermissions('dispute.read')
  @ApiOperation({ summary: 'Download an evidence file (audited)' })
  async evidence(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string, @Param('evidenceId', new ZodValidationPipe(disputeEvidenceIdSchema)) evidenceId: string, @Res() res: Response) {
    const f = await this.disputes.evidenceFile(actor, id, evidenceId);
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    f.stream.pipe(res);
  }

  @Post(':id/evidence')
  @RequirePermissions('dispute.respond')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add an evidence file (PDF or image, up to 5 MB, 10 per dispute)' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 1 } }))
  addEvidence(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string, @UploadedFile() file?: Express.Multer.File, @Body() body?: { description?: string }) {
    return this.disputes.addEvidence(actor, id, file, typeof body?.description === 'string' ? body.description : undefined);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('dispute.respond')
  @ApiOperation({ summary: 'Submit your evidence and explanation for review' })
  @ApiZodBody(submitDisputeSchema)
  submit(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string, @Body(new ZodValidationPipe(submitDisputeSchema)) body: z.output<typeof submitDisputeSchema>) {
    return this.disputes.submit(actor, id, body.note);
  }

  @Post(':id/accept')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('dispute.respond')
  @ApiOperation({ summary: 'Accept the dispute (the held amount goes back to the customer)' })
  @ApiZodBody(acceptDisputeSchema)
  accept(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string, @Body(new ZodValidationPipe(acceptDisputeSchema)) body: z.output<typeof acceptDisputeSchema>) {
    return this.disputes.accept(actor, id, body.note);
  }
}

@ApiTags('Disputes')
@ApiBearerAuth()
@Controller('v1/admin/disputes')
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  @RequireStepUp()
  @RequirePermissions('dispute.manage')
  @ApiOperation({ summary: 'Open a dispute on a captured payment (freezes the amount)' })
  @ApiZodBody(openDisputeSchema)
  open(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(openDisputeSchema)) body: z.output<typeof openDisputeSchema>) {
    return this.disputes.open(actor, body);
  }

  @Post(':id/resolve')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('dispute.manage')
  @ApiOperation({ summary: 'Decide a dispute: WON releases the hold; LOST debits it (plus any fee + GST)' })
  @ApiZodBody(resolveDisputeSchema)
  resolve(@CurrentActor() actor: Actor, @Param('id', disputeId) id: string, @Body(new ZodValidationPipe(resolveDisputeSchema)) body: z.output<typeof resolveDisputeSchema>) {
    return this.disputes.resolve(actor, id, body);
  }
}
