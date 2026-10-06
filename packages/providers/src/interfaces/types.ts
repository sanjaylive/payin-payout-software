/**
 * Provider contracts (docs/ARCHITECTURE.md §9). Adapters translate between these normalized shapes
 * and a bank/PSP's API. Adapters never touch the database and never decide business outcomes.
 */

export const PAYIN_METHODS = ['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK', 'VIRTUAL_ACCOUNT', 'IMPS', 'NEFT', 'RTGS', 'CARD', 'NETBANKING'] as const;
export type PayinMethod = (typeof PAYIN_METHODS)[number];
export const PAYOUT_MODES = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export interface ProviderContext {
  providerId: string;
  providerCode: string;
  environment: 'TEST' | 'LIVE';
  /** Decrypted credentials — never log this object. */
  credentials: Readonly<Record<string, string>>;
  /** Non-secret configuration (base_url, timeout_ms, simulation knobs for mocks). */
  config: Readonly<Record<string, unknown>>;
  /** Propagated to the provider where supported, always to our logs. */
  requestId: string;
  timeoutMs: number;
}

// ---- Payin --------------------------------------------------------------------------------------

export interface CreatePaymentRequest {
  /** Our payment id (pay_…) — sent as the provider's merchant reference / idempotency key. */
  reference: string;
  amountMinor: bigint;
  currency: 'INR';
  method: PayinMethod;
  customer?: { name?: string; mobile?: string; email?: string; vpa?: string };
  description?: string;
  expiresAt: Date;
}

export type PaymentProviderStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';

export interface CreatePaymentResult {
  providerOrderId: string;
  status: PaymentProviderStatus;
  qrPayload?: string;
  upiIntent?: string;
  paymentLink?: string;
  expiresAt?: Date;
}

export interface PaymentStatusResult {
  providerOrderId: string;
  status: PaymentProviderStatus;
  amountMinor?: bigint;
  providerTransactionId?: string;
  utr?: string;
  rrn?: string;
  payerVpa?: string;
  failureReason?: string;
  completedAt?: Date;
}

export interface RefundRequest {
  reference: string;
  providerOrderId: string;
  providerTransactionId?: string;
  amountMinor: bigint;
  reason?: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  failureReason?: string;
}

// ---- Payout -------------------------------------------------------------------------------------

export interface PayoutBeneficiary {
  name: string;
  accountNumber?: string;
  ifsc?: string;
  vpa?: string;
}

export interface CreatePayoutRequest {
  /** Our attempt reference — the provider idempotency key, unique per attempt. */
  reference: string;
  amountMinor: bigint;
  currency: 'INR';
  mode: PayoutMode;
  beneficiary: PayoutBeneficiary;
  purpose: string;
  narration?: string;
}

export type PayoutProviderStatus = 'ACCEPTED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED';

export interface CreatePayoutResult {
  providerReference: string;
  status: PayoutProviderStatus;
  utr?: string;
  failureCode?: string;
  failureReason?: string;
}

export interface PayoutStatusResult {
  providerReference: string;
  status: PayoutProviderStatus;
  utr?: string;
  failureCode?: string;
  failureReason?: string;
  completedAt?: Date;
}

export interface VerifyBeneficiaryRequest {
  reference: string;
  name: string;
  accountNumber?: string;
  ifsc?: string;
  vpa?: string;
}

export interface BeneficiaryVerification {
  status: 'VERIFIED' | 'FAILED' | 'PENDING';
  registeredName?: string;
  /** 0–100 similarity between declared and registered names. */
  nameMatchScore?: number;
  providerReference: string;
  failureReason?: string;
}

export interface ProviderBalance {
  availableMinor: bigint;
  currency: 'INR';
}

// ---- Webhooks -----------------------------------------------------------------------------------

export interface NormalizedWebhookEvent {
  externalEventId: string;
  type: 'payment.status' | 'refund.status' | 'payout.status';
  reference?: string;
  providerOrderId?: string;
  providerReference?: string;
  status: string;
  amountMinor?: bigint;
  utr?: string;
  rrn?: string;
  payerVpa?: string;
  failureReason?: string;
}

export interface WebhookVerification {
  valid: boolean;
  event?: NormalizedWebhookEvent;
  reason?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

// ---- Interfaces ---------------------------------------------------------------------------------

export interface PayinProvider {
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult>;
  refundPayment(req: RefundRequest): Promise<RefundResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification;
  healthCheck(): Promise<HealthCheckResult>;
}

export interface PayoutProvider {
  createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult>;
  getPayoutStatus(providerReference: string): Promise<PayoutStatusResult>;
  verifyBeneficiary(req: VerifyBeneficiaryRequest): Promise<BeneficiaryVerification>;
  getBalance(): Promise<ProviderBalance>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification;
  healthCheck(): Promise<HealthCheckResult>;
}
