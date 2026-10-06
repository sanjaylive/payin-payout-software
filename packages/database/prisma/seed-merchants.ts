/* eslint-disable no-console */
/**
 * Demo onboarding data for the three seeded merchants (development only):
 *  - Sharma Electronics (LLP, via reseller)      → APPROVED, all documents verified
 *  - Kirana Fresh Mart (proprietorship, reseller) → UNDER_REVIEW
 *  - Nimbus Software (private limited, direct)    → DRAFT, partially filled
 * Identifiers are synthetic but pass format/checksum validation. Never real people or businesses.
 */
import { createHash } from 'node:crypto';
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import { gstinCheckChar, maskTail } from '@pay2all/validation';
import type { DocumentType, Prisma, PrismaClient } from '../src/index';

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return `${first14}${gstinCheckChar(first14)}`;
};

/** Minimal valid PDF so magic-byte checks and downloads behave like real files. */
const placeholderPdf = (label: string) =>
  Buffer.from(`%PDF-1.4\n% Pay2All demo document: ${label}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);

interface Ctx {
  db: PrismaClient;
  enc: FieldEncryptor;
  s3: S3Client | null;
  bucket: string;
  reviewerId: string;
  makerId: string;
}

async function storageClient(): Promise<{ s3: S3Client | null; bucket: string }> {
  const bucket = process.env.S3_BUCKET ?? 'pay2all-documents';
  if (!process.env.S3_ENDPOINT) return { s3: null, bucket };
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'ap-south-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env.S3_SECRET_KEY ?? '' },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      console.warn(`  ! Object storage unavailable (${(err as Error).message}); documents seeded without files.`);
      return { s3: null, bucket };
    }
  }
  return { s3, bucket };
}

async function addDocument(ctx: Ctx, merchantId: string, type: DocumentType, status: 'UPLOADED' | 'VERIFIED', personId?: string) {
  const id = newId('merchantDocument');
  const body = placeholderPdf(`${type} for ${merchantId}`);
  const storageKey = `merchants/${merchantId}/documents/${id}.pdf`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (ctx.s3) {
    await ctx.s3.send(new PutObjectCommand({ Bucket: ctx.bucket, Key: storageKey, Body: body, ContentType: 'application/pdf', Metadata: { sha256 } }));
  }
  await ctx.db.merchantDocument.create({
    data: {
      id,
      merchantId,
      personId: personId ?? null,
      type,
      status,
      fileName: `${type.toLowerCase()}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: body.length,
      sha256,
      storageKey,
      uploadedById: ctx.makerId,
      ...(status === 'VERIFIED' ? { reviewedById: ctx.reviewerId, reviewedAt: new Date() } : {}),
    },
  });
}

async function addPerson(ctx: Ctx, merchantId: string, p: { name: string; pan: string; director: boolean; ubo: boolean; signatory: boolean; ownership?: string; din?: string }) {
  const person = await ctx.db.merchantPerson.create({
    data: {
      id: newId('merchantPerson'),
      merchantId,
      fullName: p.name,
      designation: p.director ? 'Designated Partner' : null,
      panEncrypted: ctx.enc.encrypt(p.pan, merchantId),
      panMasked: maskTail(p.pan, 4),
      panHash: ctx.enc.blindIndex(p.pan, 'person-pan'),
      din: p.din ?? null,
      isDirector: p.director,
      isUbo: p.ubo,
      isAuthorizedSignatory: p.signatory,
      ownershipPercent: p.ownership ?? null,
    },
  });
  return person.id;
}

async function addBank(ctx: Ctx, merchantId: string, holder: string, number: string, ifsc: string, bank: string, verified: boolean) {
  await ctx.db.merchantBankAccount.create({
    data: {
      id: newId('bankAccount'),
      merchantId,
      accountHolderName: holder,
      accountNumberEncrypted: ctx.enc.encrypt(number, merchantId),
      accountNumberMasked: maskTail(number, 4),
      accountNumberHash: ctx.enc.blindIndex(`${ifsc.slice(0, 4)}:${number}`, 'bank-account'),
      ifsc,
      bankName: bank,
      isPrimary: true,
      createdById: ctx.makerId,
      ...(verified ? { verificationStatus: 'VERIFIED', verificationReference: 'DEMO-PENNY-DROP-001', verifiedById: ctx.reviewerId, verifiedAt: new Date() } : {}),
    },
  });
}

async function review(ctx: Ctx, merchantId: string, action: Prisma.ComplianceReviewCreateInput['action'], from: Prisma.ComplianceReviewCreateInput['fromStatus'], to: Prisma.ComplianceReviewCreateInput['toStatus'], by: string, reason: string) {
  await ctx.db.complianceReview.create({ data: { id: newId('complianceReview'), merchantId, action, fromStatus: from ?? null, toStatus: to, reviewedById: by, reason } });
}

const address = (line1: string, city: string, state: string, pincode: string) => ({ line1, city, state, pincode, country: 'IN' });

/** Ensure every MERCHANT organization has its merchant aggregate (the migration backfill ran before seeding). */
export async function ensureMerchantAggregates(db: PrismaClient): Promise<void> {
  const orgs = await db.organization.findMany({ where: { type: 'MERCHANT', merchant: null }, include: { parent: true } });
  for (const o of orgs) {
    await db.merchant.create({ data: { id: o.id, resellerId: o.parent?.type === 'RESELLER' ? o.parent.id : null } });
    await db.merchantProfile.create({ data: { merchantId: o.id, displayName: o.name } });
    await db.merchantKyc.create({ data: { merchantId: o.id } });
  }
}

export async function seedMerchantOnboarding(
  db: PrismaClient,
  ids: { sharma: string; kirana: string; nimbus: string; complianceUserId: string; resellerUserId: string; nimbusOwnerId: string },
): Promise<void> {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is required to seed encrypted merchant data');
  const keyId = process.env.ENCRYPTION_KEY_ID ?? 'k1';
  const enc = new FieldEncryptor(createKeyring(keyId, { [keyId]: key }));
  const { s3, bucket } = await storageClient();
  const ctx: Ctx = { db, enc, s3, bucket, reviewerId: ids.complianceUserId, makerId: ids.resellerUserId };

  // Seed only once per merchant: skip anything already filled in.
  const already = await db.merchantProfile.count({ where: { merchantId: { in: [ids.sharma, ids.kirana, ids.nimbus] }, legalName: { not: null } } });
  if (already > 0) {
    console.log('  Merchant onboarding demo data already present — skipped.');
    return;
  }

  // --- Sharma Electronics: APPROVED -----------------------------------------------------------
  const sharmaPan = 'AAKFS1234K';
  await db.merchantProfile.update({
    where: { merchantId: ids.sharma },
    data: {
      legalName: 'Sharma Electronics LLP', entityType: 'LLP', pan: sharmaPan, gstin: gstin('27', sharmaPan), llpin: 'AAB-1234',
      registeredAddress: address('14 Lamington Road', 'Mumbai', 'Maharashtra', '400007'),
      website: 'https://sharma-electronics.example', businessCategory: 'Electronics retail', mcc: '5732',
      businessDescription: 'Retail of consumer electronics and appliances through stores and an online shop.',
      expectedMonthlyVolumeMinor: 2_50_00_000_00n, averageTicketMinor: 8_500_00n, maximumTicketMinor: 2_00_000_00n,
      payinRequired: true, payoutRequired: true, settlementPreference: 'T1',
      contactName: 'Rohit Sharma', contactEmail: 'owner@sharma-electronics.local', contactMobile: '+919876500001',
    },
  });
  const rohit = await addPerson(ctx, ids.sharma, { name: 'Rohit Sharma', pan: 'ABCPS1111A', director: true, ubo: true, signatory: true, ownership: '60.00', din: '01234567' });
  await addPerson(ctx, ids.sharma, { name: 'Meera Sharma', pan: 'ABCPS2222B', director: true, ubo: true, signatory: false, ownership: '40.00', din: '07654321' });
  await addBank(ctx, ids.sharma, 'Sharma Electronics LLP', '50200012345678', 'HDFC0000123', 'HDFC Bank', true);
  for (const t of ['PAN', 'GST_CERTIFICATE', 'CIN_CERTIFICATE', 'ADDRESS_PROOF', 'CANCELLED_CHEQUE', 'AGREEMENT'] as const) await addDocument(ctx, ids.sharma, t, 'VERIFIED');
  await addDocument(ctx, ids.sharma, 'DIRECTOR_KYC', 'VERIFIED', rohit);
  await db.merchantPerson.updateMany({ where: { merchantId: ids.sharma }, data: { kycStatus: 'VERIFIED' } });
  await db.merchantKyc.update({ where: { merchantId: ids.sharma }, data: { sanctionsStatus: 'CLEAR', pepStatus: 'CLEAR', adverseMediaStatus: 'CLEAR', screenedAt: new Date(), screenedById: ids.complianceUserId } });
  await db.merchant.update({ where: { id: ids.sharma }, data: { status: 'APPROVED', riskCategory: 'LOW', payinEnabled: true, payoutEnabled: true, submittedAt: new Date(), approvedAt: new Date(), version: 4 } });
  await review(ctx, ids.sharma, 'SUBMITTED', 'DRAFT', 'SUBMITTED', ids.resellerUserId, 'Submitted for compliance review');
  await review(ctx, ids.sharma, 'REVIEW_STARTED', 'SUBMITTED', 'UNDER_REVIEW', ids.complianceUserId, 'Review started');
  await review(ctx, ids.sharma, 'APPROVED', 'UNDER_REVIEW', 'APPROVED', ids.complianceUserId, 'All KYB checks passed (demo data)');

  // --- Kirana Fresh Mart: UNDER_REVIEW --------------------------------------------------------
  const kiranaPan = 'BKXPD5678M';
  await db.merchantProfile.update({
    where: { merchantId: ids.kirana },
    data: {
      legalName: 'Anita Desai (Kirana Fresh Mart)', entityType: 'PROPRIETORSHIP', pan: kiranaPan, gstin: gstin('29', kiranaPan),
      registeredAddress: address('22 4th Cross, Indiranagar', 'Bengaluru', 'Karnataka', '560038'),
      appUrl: 'https://kiranafresh.example/app', businessCategory: 'Grocery', mcc: '5411',
      businessDescription: 'Neighbourhood grocery with app-based ordering and doorstep delivery.',
      expectedMonthlyVolumeMinor: 40_00_000_00n, averageTicketMinor: 650_00n, maximumTicketMinor: 15_000_00n,
      payinRequired: true, payoutRequired: false, settlementPreference: 'T1',
      contactName: 'Anita Desai', contactEmail: 'owner@kirana-fresh.local', contactMobile: '+919876500002',
    },
  });
  const anita = await addPerson(ctx, ids.kirana, { name: 'Anita Desai', pan: kiranaPan, director: true, ubo: true, signatory: true, ownership: '100.00' });
  await addBank(ctx, ids.kirana, 'Anita Desai', '000401234567', 'ICIC0000004', 'ICICI Bank', false);
  for (const t of ['PAN', 'GST_CERTIFICATE', 'ADDRESS_PROOF', 'CANCELLED_CHEQUE'] as const) await addDocument(ctx, ids.kirana, t, 'UPLOADED');
  await addDocument(ctx, ids.kirana, 'DIRECTOR_KYC', 'UPLOADED', anita);
  await db.merchantKyc.update({ where: { merchantId: ids.kirana }, data: { sanctionsStatus: 'PENDING', pepStatus: 'PENDING', adverseMediaStatus: 'NOT_STARTED' } });
  await db.merchant.update({ where: { id: ids.kirana }, data: { status: 'UNDER_REVIEW', submittedAt: new Date(), version: 3 } });
  await review(ctx, ids.kirana, 'SUBMITTED', 'DRAFT', 'SUBMITTED', ids.resellerUserId, 'Submitted for compliance review');
  await review(ctx, ids.kirana, 'REVIEW_STARTED', 'SUBMITTED', 'UNDER_REVIEW', ids.complianceUserId, 'Review started');

  // --- Nimbus Software: DRAFT (partially filled by the owner) ---------------------------------
  await db.merchantProfile.update({
    where: { merchantId: ids.nimbus },
    data: {
      legalName: 'Nimbus Software Private Limited', entityType: 'PRIVATE_LIMITED', pan: 'AANCN4321Q', cin: 'U72200KA2019PTC123456',
      registeredAddress: address('3rd Floor, 80 Feet Road, Koramangala', 'Bengaluru', 'Karnataka', '560034'),
      website: 'https://nimbus.example', businessCategory: 'SaaS', mcc: '5734', updatedById: ids.nimbusOwnerId,
    },
  });

  console.log(`  Merchant onboarding: Sharma APPROVED, Kirana UNDER_REVIEW, Nimbus DRAFT${s3 ? '' : ' (no document files)'}.`);
}
