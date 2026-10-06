import { minorToMajorString } from '@pay2all/ledger';
import type { Prisma } from '@pay2all/database';

const major = (v: bigint | null | undefined) => (v === null || v === undefined ? null : minorToMajorString(v));

export const MERCHANT_LIST_SELECT = {
  id: true,
  status: true,
  resellerId: true,
  payinEnabled: true,
  payoutEnabled: true,
  riskCategory: true,
  submittedAt: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { name: true, status: true, assignedSalesUserId: true, source: true, parent: { select: { id: true, name: true, type: true } } } },
  profile: { select: { legalName: true, displayName: true, entityType: true, businessCategory: true } },
} satisfies Prisma.MerchantSelect;

export type MerchantListRow = Prisma.MerchantGetPayload<{ select: typeof MERCHANT_LIST_SELECT }>;

export function presentMerchantSummary(m: MerchantListRow) {
  return {
    id: m.id,
    name: m.profile?.displayName ?? m.organization.name,
    legal_name: m.profile?.legalName ?? null,
    entity_type: m.profile?.entityType ?? null,
    business_category: m.profile?.businessCategory ?? null,
    status: m.status,
    organization_status: m.organization.status,
    reseller: m.organization.parent?.type === 'RESELLER' ? { id: m.organization.parent.id, name: m.organization.parent.name } : null,
    payin_enabled: m.payinEnabled,
    payout_enabled: m.payoutEnabled,
    risk_category: m.riskCategory,
    assigned_sales_user_id: m.organization.assignedSalesUserId,
    source: m.organization.source,
    submitted_at: m.submittedAt,
    approved_at: m.approvedAt,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

type Profile = Prisma.MerchantProfileGetPayload<object>;

export function presentProfile(p: Profile | null) {
  if (!p) return null;
  return {
    legal_name: p.legalName,
    display_name: p.displayName,
    entity_type: p.entityType,
    pan: p.pan,
    gstin: p.gstin,
    cin: p.cin,
    llpin: p.llpin,
    registered_address: p.registeredAddress,
    operational_address: p.operationalAddress,
    website: p.website,
    app_url: p.appUrl,
    business_category: p.businessCategory,
    mcc: p.mcc,
    business_description: p.businessDescription,
    expected_monthly_volume: major(p.expectedMonthlyVolumeMinor),
    average_ticket_size: major(p.averageTicketMinor),
    maximum_ticket_size: major(p.maximumTicketMinor),
    payin_required: p.payinRequired,
    payout_required: p.payoutRequired,
    settlement_preference: p.settlementPreference,
    contact_name: p.contactName,
    contact_email: p.contactEmail,
    contact_mobile: p.contactMobile,
    updated_at: p.updatedAt,
  };
}

type Person = Prisma.MerchantPersonGetPayload<object>;

/** PAN is returned masked only; the encrypted value never leaves the server. */
export function presentPerson(p: Person) {
  return {
    id: p.id,
    full_name: p.fullName,
    designation: p.designation,
    pan_masked: p.panMasked,
    din: p.din,
    email: p.email,
    mobile: p.mobile,
    is_director: p.isDirector,
    is_ubo: p.isUbo,
    is_authorized_signatory: p.isAuthorizedSignatory,
    ownership_percent: p.ownershipPercent?.toFixed(2) ?? null,
    kyc_status: p.kycStatus,
    created_at: p.createdAt,
  };
}

type BankAccount = Prisma.MerchantBankAccountGetPayload<object>;

export function presentBankAccount(b: BankAccount, duplicateElsewhere = false) {
  return {
    id: b.id,
    account_holder_name: b.accountHolderName,
    account_number_masked: b.accountNumberMasked,
    ifsc: b.ifsc,
    bank_name: b.bankName,
    account_type: b.accountType,
    verification_status: b.verificationStatus,
    verification_reference: b.verificationReference,
    verified_at: b.verifiedAt,
    is_primary: b.isPrimary,
    is_active: b.isActive,
    /** Risk signal: the same account is registered to another merchant. */
    shared_with_other_merchants: duplicateElsewhere,
    created_at: b.createdAt,
  };
}

type Document = Prisma.MerchantDocumentGetPayload<object>;

export function presentDocument(d: Document) {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    person_id: d.personId,
    file_name: d.fileName,
    mime_type: d.mimeType,
    size_bytes: d.sizeBytes,
    sha256: d.sha256,
    description: d.description,
    expires_at: d.expiresAt?.toISOString().slice(0, 10) ?? null,
    rejection_reason: d.rejectionReason,
    reviewed_by_id: d.reviewedById,
    reviewed_at: d.reviewedAt,
    uploaded_by_id: d.uploadedById,
    created_at: d.createdAt,
  };
}

type Review = Prisma.ComplianceReviewGetPayload<object>;

export function presentReview(r: Review) {
  return {
    id: r.id,
    action: r.action,
    from_status: r.fromStatus,
    to_status: r.toStatus,
    reviewed_by_id: r.reviewedById,
    reviewed_at: r.reviewedAt,
    reason: r.reason,
    notes: r.notes,
    details: r.details,
    request_id: r.requestId,
  };
}
