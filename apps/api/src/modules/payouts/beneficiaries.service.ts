import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { type Beneficiary, type DbClient, isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { classify } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import { type beneficiaryInputSchema, type listBeneficiariesQuerySchema, maskTail, NAME_MATCH_THRESHOLD, nameMatchScore } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { RoutingService } from '../providers/routing.service';
import { presentBeneficiary } from './payout.presenter';

type BeneficiaryInput = z.output<typeof beneficiaryInputSchema>;

/** Bank names from the IFSC's 4-letter bank code (display only; the IFSC itself is authoritative). */
const BANKS: Record<string, string> = {
  HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', SBIN: 'State Bank of India', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank', PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India', YESB: 'Yes Bank', IDIB: 'Indian Bank', INDB: 'IndusInd Bank',
  IDFB: 'IDFC FIRST Bank', BKID: 'Bank of India', FDRL: 'Federal Bank', RATN: 'RBL Bank', AUBL: 'AU Small Finance Bank',
};

const ACCOUNT_INDEX = 'beneficiary-account';

/**
 * Beneficiaries (docs/PAYOUT_FLOW.md §3). Account numbers are encrypted with the merchant id as
 * associated data, masked for display, and blind-indexed for dedupe/risk lookups. Decryption
 * happens only in `destinationFor`, used by the payout processor right before the provider call.
 */
@Injectable()
export class BeneficiariesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
    private readonly registry: ProviderRegistryService,
  ) {}

  private fields(merchantId: string, input: BeneficiaryInput) {
    if (input.account_number) {
      const ifsc = input.ifsc!;
      return {
        accountNumberEncrypted: this.encryptor.encrypt(input.account_number, `beneficiary:${merchantId}`),
        accountNumberMasked: maskTail(input.account_number, 4),
        accountNumberHash: this.encryptor.blindIndex(input.account_number, ACCOUNT_INDEX),
        ifsc,
        bankName: BANKS[ifsc.slice(0, 4)] ?? null,
        upiId: null,
      };
    }
    return { accountNumberEncrypted: null, accountNumberMasked: null, accountNumberHash: null, ifsc: null, bankName: null, upiId: input.upi_id!.toLowerCase() };
  }

  /** Find the merchant's existing beneficiary for this destination, or create it (inline payouts). */
  async upsert(db: DbClient, merchantId: string, input: BeneficiaryInput, actorId: string | null): Promise<{ beneficiary: Beneficiary; created: boolean }> {
    const f = this.fields(merchantId, input);
    const where: Prisma.BeneficiaryWhereInput = f.accountNumberHash
      ? { merchantId, accountNumberHash: f.accountNumberHash, ifsc: f.ifsc }
      : { merchantId, accountNumberHash: null, upiId: { equals: f.upiId!, mode: 'insensitive' } };
    const existing = await db.beneficiary.findFirst({ where });
    if (existing) return { beneficiary: existing, created: false };
    try {
      const beneficiary = await db.beneficiary.create({
        data: { id: newId('beneficiary'), merchantId, name: input.name, type: input.type, mobile: input.mobile ?? null, email: input.email ?? null, createdById: actorId, ...f },
      });
      return { beneficiary, created: true };
    } catch (err) {
      // Concurrent insert of the same destination: use the winner.
      if (isUniqueViolation(err)) return { beneficiary: await db.beneficiary.findFirstOrThrow({ where }), created: false };
      throw err;
    }
  }

  async create(actor: Actor, input: BeneficiaryInput) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Beneficiaries belong to a merchant account');
    const { beneficiary, created } = await this.upsert(this.prisma, actor.organizationId, input, actor.userId);
    if (!created) throw new AppError(ErrorCode.CONFLICT, `This destination is already saved as "${beneficiary.name}"`);
    await this.audit.record({ action: 'beneficiary.created', resourceType: 'beneficiary', resourceId: beneficiary.id, organizationId: actor.organizationId, newValue: presentBeneficiary(beneficiary) });
    return presentBeneficiary(beneficiary);
  }

  async require(actor: Actor, id: string): Promise<Beneficiary> {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const b = await this.prisma.beneficiary.findFirst({ where: { id, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!b) throw new AppError(ErrorCode.NOT_FOUND, 'Beneficiary not found');
    return b;
  }

  async get(actor: Actor, id: string) {
    return presentBeneficiary(await this.require(actor, id));
  }

  async list(actor: Actor, q: z.output<typeof listBeneficiariesQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.beneficiary.findMany({
      where: {
        AND: [
          ids ? { merchantId: { in: ids } } : {},
          q.merchant_id ? { merchantId: q.merchant_id } : {},
          q.status ? { verificationStatus: q.status } : {},
          q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { upiId: { contains: q.search.toLowerCase() } }, { accountNumberMasked: { endsWith: q.search.slice(-4) } }] } : {},
          cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (b) => presentBeneficiary(b, { list: true }));
  }

  /** Penny-drop / VPA validation through the primary payout provider; compares the registered name. */
  async verify(actor: Actor, id: string) {
    const b = await this.require(actor, id);
    if (b.verificationStatus === 'BLOCKED') throw new AppError(ErrorCode.BENEFICIARY_BLOCKED);
    const decision = await this.routing.decide({ service: 'PAYOUT', merchantId: b.merchantId, amountMinor: 100n, method: b.upiId ? 'UPI' : 'IMPS' });
    const candidate = decision.candidates[0];
    if (!candidate) throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'No provider can verify beneficiaries right now');
    const { adapter } = await this.registry.payout(candidate.providerId);
    let result;
    try {
      result = await adapter.verifyBeneficiary({ reference: `${b.id}-v${b.version}`, name: b.name, ...(b.upiId ? { vpa: b.upiId } : { accountNumber: this.decryptAccount(b), ifsc: b.ifsc! }) });
    } catch (raw) {
      const err = classify(raw, candidate.providerCode);
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, err.kind === 'REJECTED' ? `Verification rejected: ${err.message}` : 'Verification could not be completed; try again shortly');
    }
    const score = result.registeredName ? (result.nameMatchScore ?? nameMatchScore(b.name, result.registeredName)) : null;
    const status = result.status === 'VERIFIED' && score !== null && score < NAME_MATCH_THRESHOLD ? 'FAILED' : result.status === 'PENDING' ? 'PENDING' : result.status;
    const updated = await this.prisma.beneficiary.update({
      where: { id: b.id },
      data: {
        verificationStatus: status,
        verificationReference: result.providerReference,
        verifiedName: result.registeredName ?? null,
        nameMatchScore: score,
        verifiedAt: status === 'VERIFIED' ? new Date() : null,
        verificationFailure: status === 'FAILED' ? (result.failureReason ?? `Registered name "${result.registeredName}" does not match (score ${score})`) : null,
        version: { increment: 1 },
      },
    });
    await this.audit.record({ action: 'beneficiary.verified', resourceType: 'beneficiary', resourceId: b.id, organizationId: b.merchantId, metadata: { status, name_match_score: score, provider: candidate.providerCode } });
    return presentBeneficiary(updated);
  }

  async block(actor: Actor, id: string, reason: string) {
    const b = await this.require(actor, id);
    const updated = await this.prisma.beneficiary.update({ where: { id: b.id }, data: { verificationStatus: 'BLOCKED', blockedReason: reason, version: { increment: 1 } } });
    await this.audit.record({ action: 'beneficiary.blocked', resourceType: 'beneficiary', resourceId: b.id, organizationId: b.merchantId, metadata: { reason, by: actor.organizationType } });
    return presentBeneficiary(updated);
  }

  /** Full account number for the provider call only. Never logged, returned or stored elsewhere. */
  decryptAccount(b: Beneficiary): string {
    if (!b.accountNumberEncrypted) throw new Error('Beneficiary has no bank account');
    return this.encryptor.decrypt(b.accountNumberEncrypted, `beneficiary:${b.merchantId}`);
  }

  snapshot(b: Beneficiary) {
    return { beneficiary_id: b.id, name: b.name, account_number_masked: b.accountNumberMasked, ifsc: b.ifsc, bank_name: b.bankName, upi_id: b.upiId, verification_status: b.verificationStatus };
  }
}
