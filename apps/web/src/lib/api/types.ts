import type { OrganizationType } from '@pay2all/types';

export interface Me {
  user: { id: string; name: string; email: string; mobile: string | null; status: string; last_login_at: string | null; password_changed_at: string };
  organization: { id: string; name: string; type: OrganizationType; status: string };
  roles: string[];
  permissions: string[];
  session: { id: string; restricted: boolean };
  mfa: { enabled: boolean; required: boolean; recovery_codes_remaining: number };
  memberships: { organization_id: string; organization_name: string; organization_type: OrganizationType; role_key: string; role_name: string }[];
}

export interface SessionTokens {
  status: 'AUTHENTICATED' | 'MFA_ENROLLMENT_REQUIRED' | 'MFA_REQUIRED';
  access_token?: string;
  mfa_token?: string;
  expires_in: number;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  status: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  locked: boolean;
  last_login_at: string | null;
  created_at: string;
  memberships: { organization_id: string; organization_name: string; organization_type: OrganizationType; role_key: string; role_name: string; granted_at: string }[];
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: OrganizationType;
  is_system: boolean;
  requires_mfa: boolean;
  permissions: string[];
  member_count?: number;
}

export interface AuditLogRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  organization_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  old_value: unknown;
  new_value: unknown;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  current: boolean;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  mfa_verified: boolean;
}

export type MerchantStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'MORE_INFORMATION_REQUIRED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
}

export interface MerchantSummary {
  id: string;
  name: string;
  legal_name: string | null;
  entity_type: string | null;
  business_category: string | null;
  status: MerchantStatus;
  organization_status: string;
  reseller: { id: string; name: string } | null;
  payin_enabled: boolean;
  payout_enabled: boolean;
  risk_category: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  assigned_sales_user_id: string | null;
  source: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface MerchantProfile {
  legal_name: string | null;
  display_name: string | null;
  entity_type: string | null;
  pan: string | null;
  gstin: string | null;
  cin: string | null;
  llpin: string | null;
  registered_address: Address | null;
  operational_address: Address | null;
  website: string | null;
  app_url: string | null;
  business_category: string | null;
  mcc: string | null;
  business_description: string | null;
  expected_monthly_volume: string | null;
  average_ticket_size: string | null;
  maximum_ticket_size: string | null;
  payin_required: boolean;
  payout_required: boolean;
  settlement_preference: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_mobile: string | null;
}

export interface MerchantPerson {
  id: string;
  full_name: string;
  designation: string | null;
  pan_masked: string;
  din: string | null;
  email: string | null;
  mobile: string | null;
  is_director: boolean;
  is_ubo: boolean;
  is_authorized_signatory: boolean;
  ownership_percent: string | null;
  kyc_status: string;
}

export interface MerchantBankAccount {
  id: string;
  account_holder_name: string;
  account_number_masked: string;
  ifsc: string;
  bank_name: string | null;
  account_type: string;
  verification_status: string;
  verification_reference: string | null;
  is_primary: boolean;
  shared_with_other_merchants: boolean;
  created_at: string;
}

export interface MerchantDocument {
  id: string;
  type: string;
  status: string;
  person_id: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  expires_at: string | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  uploaded_by_id: string | null;
  created_at: string;
}

export interface ComplianceReview {
  id: string;
  action: string;
  from_status: MerchantStatus | null;
  to_status: MerchantStatus;
  reviewed_by_id: string | null;
  reviewed_at: string;
  reason: string | null;
  notes: string | null;
}

export interface Requirement {
  key: string;
  label: string;
  satisfied: boolean;
  stage: 'SUBMISSION' | 'APPROVAL';
}

export interface MerchantApplication extends MerchantSummary {
  profile: MerchantProfile;
  persons: MerchantPerson[];
  bank_accounts: MerchantBankAccount[];
  documents: MerchantDocument[];
  screening: { sanctions_status: string; pep_status: string; adverse_media_status: string; screened_at: string | null; risk_notes?: string | null } | null;
  requirements: Requirement[];
  can_submit: boolean;
  reviews: ComplianceReview[];
  version: number;
}

export interface ResolvedLimit {
  value: string | number | null;
  source: 'SYSTEM' | 'RESELLER' | 'MERCHANT' | null;
}

export type EffectiveLimits = Record<'payin' | 'payout', Record<string, ResolvedLimit>>;

export interface ApprovalPolicy {
  source?: string;
  maker_checker_enabled: boolean;
  tiers: { up_to_minor: string | null; approvals_required: number }[];
}

export interface SalesLead {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string | null;
  contact_mobile: string | null;
  source: string;
  expected_monthly_volume: string | null;
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'LOST';
  assigned_sales_user_id: string | null;
  follow_up_date: string | null;
  notes: { at: string; by: string; text: string }[];
  converted_merchant_id: string | null;
  created_at: string;
}
