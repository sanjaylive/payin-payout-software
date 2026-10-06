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

export interface MerchantBalances {
  merchant_id: string;
  currency: string;
  available: string;
  pending: string;
  unsettled: string;
  reserved: string;
  lien: string;
  settled_to_date: string;
  receivable: string;
  as_of: string;
}

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: 'DEBIT' | 'CREDIT';
  owner_type: string;
  owner_id: string | null;
  bucket: string | null;
  currency: string;
  maintained: boolean;
  balance: string | null;
  created_at: string;
}

export interface StatementEntry {
  id: string;
  journal_id: string;
  journal_type: string;
  source_type: string;
  source_id: string;
  description: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balance_after: string | null;
  created_at: string;
}

export interface LedgerJournal {
  id: string;
  type: string;
  idempotency_key?: string;
  source_type: string;
  source_id: string;
  description: string | null;
  reverses_journal_id: string | null;
  reversed_by_journal_id: string | null;
  effective_at: string;
  posted_at: string;
  created_by_id?: string | null;
  request_id: string | null;
  entries: { id: string; account_id: string; account_code: string; account_name: string; bucket: string | null; direction: 'DEBIT' | 'CREDIT'; amount: string; balance_after: string | null }[];
}

export interface LedgerAdjustment {
  id: string;
  merchant_id: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  reason: string;
  reference: string;
  supporting_note: string | null;
  status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED';
  approvals_required: number;
  approvals: { approver_id: string; comment: string | null; approved_at: string }[];
  maker_id: string;
  journal_id: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface TrialBalance {
  debits: string;
  credits: string;
  difference: string;
  balanced: boolean;
  entries: number;
  journals: number;
}

export interface ProviderHealth {
  window_minutes: number;
  requests: number;
  success_rate: number | null;
  failure_rate: number | null;
  timeout_rate: number | null;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
}

export interface ProviderRow {
  id: string;
  code: string;
  name: string;
  kind: 'PAYIN' | 'PAYOUT' | 'BOTH';
  adapter: string;
  adapter_label: string;
  required_credentials: string[];
  environment: 'TEST' | 'LIVE';
  status: string;
  status_source: 'AUTO' | 'MANUAL';
  status_reason: string | null;
  status_changed_at: string;
  capabilities: { payin_methods?: string[]; payout_modes?: string[]; min_amount_minor?: string; max_amount_minor?: string };
  config: Record<string, string | number | boolean>;
  costs: { payin_rate_micros?: string; payout_flat_minor?: string };
  credentials: { environment: string; fingerprints: Record<string, string>; rotated_at: string }[];
  health?: { payin: ProviderHealth | null; payout: ProviderHealth | null };
  snapshots?: { service: string; window_end: string; requests: number; success_rate: number | null; p95_latency_ms: number | null; status: string }[];
}

export interface ProviderRoute {
  id: string;
  name: string;
  service: 'PAYIN' | 'PAYOUT';
  tier: 'PRIMARY' | 'SECONDARY' | 'FALLBACK';
  priority: number;
  is_active: boolean;
  provider: { id: string; code: string; name: string; status: string };
  merchant_id: string | null;
  reseller_id: string | null;
  method: string | null;
  min_amount: string | null;
  max_amount: string | null;
  risk_categories: string[];
  time_window: { start: string; end: string; days?: number[] } | null;
}

export interface RoutingSimulation {
  candidates: { order: number; provider_code: string; route_name: string; tier: string; degraded: boolean }[];
  evaluations: { route_id: string; route_name: string; provider_code: string; tier: string; selected: boolean; reasons: string[] }[];
}

export type PaymentStatus =
  | 'CREATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'SETTLEMENT_PENDING' | 'SETTLED'
  | 'REFUND_PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'DISPUTED' | 'CHARGEBACK';
export type PayinMethod = 'UPI_QR' | 'UPI_INTENT' | 'PAYMENT_LINK';

export interface Refund {
  refund_id: string;
  payment_id: string;
  merchant_refund_id: string | null;
  amount: string;
  currency: string;
  status: 'CREATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'MANUAL_REVIEW';
  reason: string | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PaymentAttemptRow {
  attempt_no: number;
  provider: string;
  status: string;
  error_kind: string | null;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface Payment {
  payment_id: string;
  merchant_id: string;
  merchant_order_id: string;
  amount: string;
  currency: string;
  fee: string;
  tax: string;
  net_amount: string;
  refunded_amount: string;
  status: PaymentStatus;
  method: PayinMethod;
  qr?: string | null;
  upi_intent?: string | null;
  payment_link: string | null;
  expires_at: string;
  utr: string | null;
  rrn: string | null;
  payer_vpa: string | null;
  customer: { name: string | null; mobile: string | null; email: string | null };
  description: string | null;
  metadata: Record<string, string> | null;
  late_success: boolean;
  requires_review: boolean;
  review_reason?: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  success_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
  provider?: string | null;
  provider_order_id?: string | null;
  provider_transaction_id?: string | null;
  reseller_id?: string | null;
  refunds?: Refund[];
  attempts?: PaymentAttemptRow[];
}

export interface PaymentStatsBucket {
  bucket_start: string;
  count: number;
  success_count: number;
  failed_count: number;
  success_amount: string;
}

export interface PaymentStats {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  totals: { count: number; success_count: number; failed_count: number; success_amount: string; success_rate: number | null };
  series: PaymentStatsBucket[];
}

export interface PricingRuleRow {
  id: string;
  service: 'PAYIN' | 'PAYOUT';
  method: string | null;
  provider_id: string | null;
  min_amount: string | null;
  max_amount: string | null;
  charge_type: 'FLAT' | 'PERCENTAGE' | 'PERCENTAGE_WITH_MIN_MAX';
  rate: string | null;
  flat_fee: string | null;
  min_fee: string | null;
  max_fee: string | null;
}

export interface PricingPlanRow {
  id: string;
  name: string;
  kind: 'PROVIDER_COST' | 'WHOLESALE' | 'MERCHANT';
  status: 'ACTIVE' | 'ARCHIVED';
  owner_org_id: string;
  is_default: boolean;
  tax_rate: string | null;
  refund_fee: boolean;
  effective_from: string;
  effective_to: string | null;
  rules: PricingRuleRow[];
  created_at: string;
}

export interface PricingQuote {
  merchant_fee: string;
  tax: string;
  wholesale_fee: string | null;
  provider_cost: string;
  reseller_margin: string;
  platform_margin: string;
}

export type PayoutStatus = 'CREATED' | 'VALIDATING' | 'APPROVAL_PENDING' | 'MANUAL_REVIEW' | 'QUEUED' | 'PROCESSING' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'REJECTED' | 'REVERSED';
export type PayoutMode = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';

export interface Beneficiary {
  beneficiary_id: string;
  merchant_id: string;
  name: string;
  type: 'INDIVIDUAL' | 'BUSINESS';
  account_number_masked: string | null;
  ifsc: string | null;
  bank_name: string | null;
  upi_id: string | null;
  mobile: string | null;
  email: string | null;
  verification_status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'BLOCKED';
  verified_name: string | null;
  name_match_score: number | null;
  verified_at: string | null;
  verification_failure: string | null;
  blocked_reason: string | null;
  created_at: string;
}

export interface PayoutBeneficiarySnapshot {
  beneficiary_id: string;
  name: string;
  account_number_masked: string | null;
  ifsc: string | null;
  bank_name: string | null;
  upi_id: string | null;
  verification_status: string;
}

export interface Payout {
  payout_id: string;
  merchant_id: string;
  merchant_order_id: string;
  amount: string;
  fee: string;
  tax: string;
  total_debit: string;
  currency: string;
  mode: PayoutMode;
  purpose: string;
  status: PayoutStatus;
  source: 'DASHBOARD' | 'API' | 'BULK';
  beneficiary: PayoutBeneficiarySnapshot;
  narration: string | null;
  approvals_required: number;
  approvals_received: number;
  approval_expires_at: string | null;
  utr: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  review_reason: string | null;
  bulk_batch_id: string | null;
  created_by_id: string | null;
  processed_at: string | null;
  reversed_at: string | null;
  created_at: string;
  updated_at: string;
  can_approve?: boolean;
  provider?: string | null;
  provider_reference?: string | null;
  approvals?: { approver_id: string; approver_name: string | null; decision: 'APPROVED' | 'REJECTED'; reason: string | null; created_at: string }[];
  attempts?: { attempt_no: number; provider: string; reference: string; status: string; error_kind: string | null; error_code: string | null; error_message: string | null; latency_ms: number | null; created_at: string }[];
}

export interface BulkBatch {
  batch_id: string;
  file_name: string;
  status: 'VALIDATED' | 'VALIDATION_FAILED' | 'CONFIRMED' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';
  total_rows: number;
  valid_rows: number;
  total_amount: string;
  approvals_required: number;
  created_count: number;
  failed_count: number;
  created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  rows?: { row_no: number; merchant_order_id: string | null; amount: string | null; mode: string | null; beneficiary: string | null; status: 'VALID' | 'INVALID' | 'CREATED' | 'FAILED'; errors: string[] | null; payout_id: string | null }[];
}

export interface WebhookEndpointRow {
  endpoint_id: string;
  merchant_id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'ACTIVE' | 'DISABLED';
  disabled_reason: string | null;
  secret_hint: string;
  previous_secret_valid_until: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only in the create / rotate response. */
  secret?: string;
}

export interface WebhookDeliveryRow {
  delivery_id: string;
  event_id: string;
  event_type: string;
  endpoint_id: string;
  endpoint_url?: string;
  merchant_id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  attempt_log?: { attempt_no: number; status_code: number | null; duration_ms: number; error: string | null; response_snippet: string | null; created_at: string }[];
  payload?: unknown;
}

export interface PipelineHealth {
  outbox_backlog: number;
  outbox_oldest_age_seconds: number;
  dead_letters_open: number;
  webhook_deliveries_pending: number;
  webhook_deliveries_failed_24h: number;
  webhook_endpoints_auto_disabled: number;
  notifications_queued: number;
}

export interface DeadLetterRow {
  id: string;
  consumer_group: string;
  topic: string;
  partition: number;
  offset: string;
  event_id: string | null;
  event_type: string | null;
  aggregate_id: string | null;
  error: string;
  attempts: number;
  created_at: string;
  requeued_at: string | null;
}
