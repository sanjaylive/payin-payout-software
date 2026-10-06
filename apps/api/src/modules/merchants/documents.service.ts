import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { documentReviewSchema, documentUploadSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { MerchantAccessService } from './merchant-access.service';
import { presentDocument } from './merchant.presenter';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Allowed KYC formats, identified by magic bytes — the client-declared MIME type is not trusted. */
const SIGNATURES: { mime: string; ext: string; magic: number[] }[] = [
  { mime: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
];

export function sniffMime(buffer: Buffer): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find((s) => s.magic.every((byte, i) => buffer[i] === byte));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

/** Keep a safe display name only (no paths, control chars or quotes); never used in storage keys. */
export function sanitizeFileName(name: string, ext: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/[^\w.\- ()]/g, '_').slice(0, 150).trim() || 'document';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: MerchantAccessService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  async upload(actor: Actor, merchantId: string, meta: z.output<typeof documentUploadSchema>, file: UploadedFile | undefined) {
    const merchant = await this.access.require(actor, merchantId);
    if (merchant.status === 'REJECTED') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Application was rejected');
    // While under review the reviewer works from a fixed snapshot: applicants wait for an information
    // request. Platform staff may still attach files (e.g. the countersigned merchant agreement).
    if ((merchant.status === 'SUBMITTED' || merchant.status === 'UNDER_REVIEW') && actor.organizationType !== 'PLATFORM') {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Documents are locked while the application is being reviewed');
    }
    if (!file) throw new AppError(ErrorCode.INVALID_REQUEST, 'Attach a file in the "file" field');
    if (file.size > this.config.env.MAX_DOCUMENT_BYTES || file.buffer.length > this.config.env.MAX_DOCUMENT_BYTES) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `File exceeds ${Math.floor(this.config.env.MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`);
    }
    const detected = sniffMime(file.buffer);
    if (!detected) throw new AppError(ErrorCode.INVALID_REQUEST, 'Only PDF, PNG and JPEG files are accepted');

    if (meta.person_id) {
      const person = await this.prisma.merchantPerson.findFirst({ where: { id: meta.person_id, merchantId }, select: { id: true } });
      if (!person) throw new AppError(ErrorCode.NOT_FOUND, 'Person not found');
    }

    const id = newId('merchantDocument');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    // Key contains only server-generated identifiers.
    const storageKey = `merchants/${merchantId}/documents/${id}.${detected.ext}`;
    await this.storage.put(storageKey, file.buffer, detected.mime, sha256);

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.merchantDocument.create({
        data: {
          id,
          merchantId,
          personId: meta.person_id ?? null,
          type: meta.type,
          fileName: sanitizeFileName(file.originalname, detected.ext),
          mimeType: detected.mime,
          sizeBytes: file.buffer.length,
          sha256,
          storageKey,
          description: meta.description ?? null,
          uploadedById: actor.userId,
        },
      });
      await this.audit.record({ action: 'merchant.document.uploaded', resourceType: 'merchant_document', resourceId: id, organizationId: merchantId, newValue: presentDocument(created) }, tx);
      return created;
    });
    return presentDocument(doc);
  }

  /** Stream a document after authorization; every access is audited (who viewed which KYC file). */
  async open(actor: Actor, merchantId: string, documentId: string): Promise<{ stream: Readable; fileName: string; mimeType: string; size: number }> {
    await this.access.require(actor, merchantId);
    const doc = await this.prisma.merchantDocument.findFirst({ where: { id: documentId, merchantId } });
    if (!doc) throw new AppError(ErrorCode.NOT_FOUND, 'Document not found');
    const stream = await this.storage.getStream(doc.storageKey);
    await this.audit.record({ action: 'merchant.document.viewed', resourceType: 'merchant_document', resourceId: documentId, organizationId: merchantId });
    return { stream, fileName: doc.fileName, mimeType: doc.mimeType, size: doc.sizeBytes };
  }

  async review(actor: Actor, merchantId: string, documentId: string, input: z.output<typeof documentReviewSchema>) {
    await this.access.require(actor, merchantId);
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.merchantDocument.findFirst({ where: { id: documentId, merchantId } });
      if (!doc) throw new AppError(ErrorCode.NOT_FOUND, 'Document not found');
      if (doc.uploadedById === actor.userId) throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED, 'You cannot review a document you uploaded');
      const updated = await tx.merchantDocument.update({
        where: { id: documentId },
        data: {
          status: input.status,
          rejectionReason: input.status === 'REJECTED' ? (input.reason ?? null) : null,
          expiresAt: input.expires_at ? new Date(input.expires_at) : doc.expiresAt,
          reviewedById: actor.userId,
          reviewedAt: new Date(),
        },
      });
      if (doc.personId && doc.type === 'DIRECTOR_KYC') {
        await tx.merchantPerson.update({ where: { id: doc.personId }, data: { kycStatus: input.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED' } });
      }
      await this.audit.record(
        { action: `merchant.document.${input.status === 'VERIFIED' ? 'verified' : 'rejected'}`, resourceType: 'merchant_document', resourceId: documentId, organizationId: merchantId, oldValue: { status: doc.status }, newValue: { status: input.status, reason: input.reason, expires_at: input.expires_at } },
        tx,
      );
      return presentDocument(updated);
    });
  }
}
