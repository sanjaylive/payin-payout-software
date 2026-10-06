import type { DocumentStatus, DocumentType, EntityType, MerchantStatus, ScreeningStatus, VerificationStatus } from '@pay2all/database';
import { panFromGstin, panMatchesEntity } from '@pay2all/validation';

/**
 * Configurable compliance requirements. Partner banks/PAs impose different checklists; this module is
 * the single place that encodes them, as data-driven rules evaluated against an application snapshot.
 */

export interface ApplicationSnapshot {
  status: MerchantStatus;
  profile: {
    legalName: string | null;
    displayName: string | null;
    entityType: EntityType | null;
    pan: string | null;
    gstin: string | null;
    cin: string | null;
    llpin: string | null;
    registeredAddress: unknown;
    website: string | null;
    appUrl: string | null;
    businessCategory: string | null;
    mcc: string | null;
    businessDescription: string | null;
    expectedMonthlyVolumeMinor: bigint | null;
    averageTicketMinor: bigint | null;
    maximumTicketMinor: bigint | null;
    payinRequired: boolean;
    payoutRequired: boolean;
    settlementPreference: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactMobile: string | null;
  } | null;
  persons: { isDirector: boolean; isUbo: boolean; isAuthorizedSignatory: boolean }[];
  bankAccounts: { isPrimary: boolean; isActive: boolean; verificationStatus: VerificationStatus }[];
  documents: { type: DocumentType; status: DocumentStatus; expiresAt: Date | null }[];
  kyc: { sanctionsStatus: ScreeningStatus; pepStatus: ScreeningStatus; adverseMediaStatus: ScreeningStatus } | null;
}

export interface RequirementItem {
  key: string;
  label: string;
  satisfied: boolean;
  stage: 'SUBMISSION' | 'APPROVAL';
}

const COMPANY_TYPES: EntityType[] = ['PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'ONE_PERSON_COMPANY'];
/** Entities with beneficial owners other than a single proprietor. */
const NEEDS_UBO: EntityType[] = ['PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'ONE_PERSON_COMPANY', 'TRUST', 'SOCIETY', 'HUF'];

export function requiredDocumentTypes(entity: EntityType | null, hasGstin: boolean): DocumentType[][] {
  // Each inner array is "any one of".
  const docs: DocumentType[][] = [['PAN'], ['ADDRESS_PROOF'], ['CANCELLED_CHEQUE', 'BANK_PROOF'], ['DIRECTOR_KYC']];
  if (hasGstin) docs.push(['GST_CERTIFICATE']);
  if (entity && (COMPANY_TYPES.includes(entity) || entity === 'LLP')) docs.push(['CIN_CERTIFICATE']);
  return docs;
}

const DOC_LABELS: Record<DocumentType, string> = {
  PAN: 'PAN card',
  GST_CERTIFICATE: 'GST registration certificate',
  CIN_CERTIFICATE: 'Certificate of incorporation',
  ADDRESS_PROOF: 'Business address proof',
  BANK_PROOF: 'Bank statement',
  CANCELLED_CHEQUE: 'Cancelled cheque',
  DIRECTOR_KYC: 'Director / proprietor KYC',
  AGREEMENT: 'Signed merchant agreement',
  OTHER: 'Other document',
};

function hasDoc(docs: ApplicationSnapshot['documents'], types: DocumentType[], acceptable: DocumentStatus[], now: Date): boolean {
  return docs.some((d) => types.includes(d.type) && acceptable.includes(d.status) && (!d.expiresAt || d.expiresAt > now));
}

const SCREENING_OK: ScreeningStatus[] = ['CLEAR', 'FALSE_POSITIVE'];

export function evaluateRequirements(app: ApplicationSnapshot, now = new Date()): RequirementItem[] {
  const p = app.profile;
  const items: RequirementItem[] = [];
  const sub = (key: string, label: string, satisfied: boolean) => items.push({ key, label, satisfied, stage: 'SUBMISSION' });
  const appr = (key: string, label: string, satisfied: boolean) => items.push({ key, label, satisfied, stage: 'APPROVAL' });

  sub('profile.identity', 'Legal name, display name and entity type', Boolean(p?.legalName && p.displayName && p.entityType));
  sub('profile.pan', 'Business PAN matching the entity type', Boolean(p?.pan && p.entityType && panMatchesEntity(p.pan, p.entityType)));
  if (p?.gstin) sub('profile.gstin_pan', 'GSTIN belongs to the business PAN', panFromGstin(p.gstin) === p.pan);
  if (p?.entityType && COMPANY_TYPES.includes(p.entityType)) sub('profile.cin', 'Corporate identity number (CIN)', Boolean(p.cin));
  if (p?.entityType === 'LLP') sub('profile.llpin', 'LLP identification number (LLPIN)', Boolean(p.llpin));
  sub('profile.address', 'Registered address', Boolean(p?.registeredAddress));
  sub('profile.online_presence', 'Website or app URL', Boolean(p?.website || p?.appUrl));
  sub('profile.business', 'Business category, MCC and description', Boolean(p?.businessCategory && p.mcc && p.businessDescription));
  sub(
    'profile.volumes',
    'Expected volume and ticket sizes (maximum ≥ average)',
    Boolean(
      p?.expectedMonthlyVolumeMinor != null &&
        p.averageTicketMinor != null &&
        p.maximumTicketMinor != null &&
        p.maximumTicketMinor >= p.averageTicketMinor,
    ),
  );
  sub('profile.services', 'Payin and/or payout selected with a settlement preference', Boolean(p && (p.payinRequired || p.payoutRequired) && p.settlementPreference));
  sub('profile.contact', 'Primary contact name, email and mobile', Boolean(p?.contactName && p.contactEmail && p.contactMobile));

  sub('persons.director', 'At least one director / partner / proprietor', app.persons.some((x) => x.isDirector));
  sub('persons.signatory', 'At least one authorized signatory', app.persons.some((x) => x.isAuthorizedSignatory));
  if (p?.entityType && NEEDS_UBO.includes(p.entityType)) {
    sub('persons.ubo', 'Ultimate beneficial owner(s) declared', app.persons.some((x) => x.isUbo));
  }

  const primary = app.bankAccounts.find((b) => b.isPrimary && b.isActive);
  sub('bank.primary', 'Primary settlement bank account', Boolean(primary));

  for (const group of requiredDocumentTypes(p?.entityType ?? null, Boolean(p?.gstin))) {
    const label = group.map((t) => DOC_LABELS[t]).join(' or ');
    sub(`documents.${group.join('|')}.uploaded`, `${label} uploaded`, hasDoc(app.documents, group, ['UPLOADED', 'VERIFIED'], now));
    appr(`documents.${group.join('|')}.verified`, `${label} verified`, hasDoc(app.documents, group, ['VERIFIED'], now));
  }
  appr('documents.AGREEMENT.verified', 'Signed merchant agreement verified', hasDoc(app.documents, ['AGREEMENT'], ['VERIFIED'], now));
  appr('bank.verified', 'Primary bank account verified', primary?.verificationStatus === 'VERIFIED');
  appr(
    'screening',
    'Sanctions, PEP and adverse-media screening cleared',
    Boolean(app.kyc && SCREENING_OK.includes(app.kyc.sanctionsStatus) && SCREENING_OK.includes(app.kyc.pepStatus) && SCREENING_OK.includes(app.kyc.adverseMediaStatus)),
  );
  return items;
}

export function unmet(items: RequirementItem[], stage: 'SUBMISSION' | 'APPROVAL'): RequirementItem[] {
  // Approval needs everything; submission needs submission items only.
  return items.filter((i) => !i.satisfied && (stage === 'APPROVAL' || i.stage === 'SUBMISSION'));
}
