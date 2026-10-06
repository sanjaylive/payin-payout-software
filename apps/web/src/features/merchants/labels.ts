export const ENTITY_LABELS: Record<string, string> = {
  PROPRIETORSHIP: 'Sole proprietorship',
  PARTNERSHIP: 'Partnership firm',
  LLP: 'Limited liability partnership (LLP)',
  PRIVATE_LIMITED: 'Private limited company',
  PUBLIC_LIMITED: 'Public limited company',
  ONE_PERSON_COMPANY: 'One person company',
  TRUST: 'Trust',
  SOCIETY: 'Society',
  HUF: 'Hindu undivided family (HUF)',
  GOVERNMENT: 'Government entity',
};

export const DOCUMENT_LABELS: Record<string, string> = {
  PAN: 'PAN card',
  GST_CERTIFICATE: 'GST certificate',
  CIN_CERTIFICATE: 'Certificate of incorporation',
  ADDRESS_PROOF: 'Address proof',
  BANK_PROOF: 'Bank statement',
  CANCELLED_CHEQUE: 'Cancelled cheque',
  DIRECTOR_KYC: 'Director / proprietor KYC',
  AGREEMENT: 'Merchant agreement',
  OTHER: 'Other',
};

export const REVIEW_ACTION_LABELS: Record<string, string> = {
  CREATED: 'Account created',
  SUBMITTED: 'Submitted for review',
  REVIEW_STARTED: 'Review started',
  INFORMATION_REQUESTED: 'More information requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SUSPENDED: 'Suspended',
  REACTIVATED: 'Reactivated',
};

export const PENDING_REVIEW_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED'];

export const isEditableStatus = (s: string) => s === 'DRAFT' || s === 'MORE_INFORMATION_REQUIRED';
