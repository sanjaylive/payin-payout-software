import { Body, Controller, Get, HttpCode, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { documentReviewSchema, documentUploadSchema, idSchema } from '@pay2all/validation';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequireAnyPermission, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { DocumentsService, type UploadedFile as UploadedDocument } from './documents.service';
import { merchantIdPipe } from './merchants.controller';

const documentIdPipe = new ZodValidationPipe(idSchema('doc'));
/** Hard ceiling at the HTTP layer; the configured MAX_DOCUMENT_BYTES is enforced in the service. */
const MULTER_CEILING_BYTES = 25 * 1024 * 1024;

@ApiTags('Merchant documents')
@ApiBearerAuth()
@Controller('v1/merchants/:merchantId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @RequireAnyPermission('merchant.update', 'compliance.approve')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MULTER_CEILING_BYTES, files: 1, fields: 5 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a KYC document (PDF/PNG/JPEG, verified by content, sha256 computed server-side)' })
  upload(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Body(new ZodValidationPipe(documentUploadSchema)) body: z.output<typeof documentUploadSchema>,
    @UploadedFile() file: UploadedDocument | undefined,
  ) {
    return this.documents.upload(actor, merchantId, body, file);
  }

  @Get(':documentId/content')
  @RequirePermissions('compliance.read')
  @ApiOperation({ summary: 'Download a document (access is audited)' })
  async content(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Param('documentId', documentIdPipe) documentId: string,
    @Res() res: Response,
  ) {
    const doc = await this.documents.open(actor, merchantId, documentId);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(doc.size));
    res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    doc.stream.pipe(res);
  }

  @Post(':documentId/review')
  @HttpCode(200)
  @RequirePermissions('compliance.approve')
  @ApiZodBody(documentReviewSchema)
  review(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Param('documentId', documentIdPipe) documentId: string,
    @Body(new ZodValidationPipe(documentReviewSchema)) body: z.output<typeof documentReviewSchema>,
  ) {
    return this.documents.review(actor, merchantId, documentId, body);
  }
}
