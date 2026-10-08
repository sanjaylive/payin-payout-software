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
  /** Hosted-checkout gateways: where the gateway sends the customer back (our API return endpoint). */
  returnUrl?: string;
  /** Server-to-server notification URL (our provider webhook endpoint), for gateways that take it per order. */
  notifyUrl?: string;
}

/** How to hand the customer to a hosted gateway page. */
export type CheckoutAction =
  | { type: 'REDIRECT'; url: string }
  /** Auto-submitting HTML form (CCAvenue, …). Field values may contain encrypted payloads. */
  | { type: 'FORM_POST'; url: string; fields: Record<string, string> }
  /** NTT DATA (Atom) AIPAY: their checkout script opens with a token. */
  | { type: 'ATOM_CHECKOUT'; scriptUrl: string; atomTokenId: string; merchId: string; custEmail: string; custMobile: string; returnUrl: string };

export type PaymentProviderStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';

export interface CreatePaymentResult {
  providerOrderId: string;
  status: PaymentProviderStatus;
  qrPayload?: string;
  upiIntent?: string;
  paymentLink?: string;
  /** Hosted gateways: how to send the customer to pay. */
  action?: CheckoutAction;
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
  type: 'payment.status' | 'refund.status' | 'payout.status' | 'static_qr.credit';
  reference?: string;
  providerOrderId?: string;
  providerReference?: string;
  status: string;
  amountMinor?: bigint;
  utr?: string;
  rrn?: string;
  payerVpa?: string;
  failureReason?: string;
  /** The callback can't be trusted for the outcome (e.g. unauthenticated encryption): check the status API now. */
  confirmByStatusApi?: boolean;
  /** static_qr.credit: the provider's QR id (providerReference = the provider's payment id). */
  providerQrId?: string;
  /** static_qr.credit: when the customer paid (ISO). */
  paidAt?: string;
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

// ---- Static QR ----------------------------------------------------------------------------------

export interface CreateStaticQrRequest {
  /** Our static QR id (sqr_…), echoed in provider notes for reconciliation. */
  reference: string;
  /** Payee name shown in the customer's UPI app (the merchant's display name). */
  name: string;
  description?: string;
}

export interface StaticQrResult {
  providerQrId: string;
  /** upi://pay?… without an amount (the customer types it). At least one of upiPayload / imageUrl. */
  upiPayload?: string;
  imageUrl?: string;
}

/** One payment into a static QR, as the provider reports it. Amounts only ever come from here. */
export interface StaticQrCredit {
  providerPaymentId: string;
  amountMinor: bigint;
  utr?: string;
  rrn?: string;
  payerVpa?: string;
  paidAt?: Date;
}

/** Optional capability of a payin adapter: multi-use, any-amount UPI QR codes. */
export interface StaticQrProvider {
  createStaticQr(req: CreateStaticQrRequest): Promise<StaticQrResult>;
  closeStaticQr(providerQrId: string): Promise<void>;
  /** Captured credits since `since` (reconciliation for missed webhooks). */
  listStaticQrCredits(providerQrId: string, since: Date): Promise<StaticQrCredit[]>;
}

export function supportsStaticQr(p: unknown): p is StaticQrProvider {
  return typeof (p as Partial<StaticQrProvider> | null)?.createStaticQr === 'function';
}

// ---- Interfaces ---------------------------------------------------------------------------------

export interface PayinProvider {
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  /** `hint` carries what some gateways need to look an order up (NTT DATA wants the amount). */
  getPaymentStatus(providerOrderId: string, hint?: { amountMinor?: bigint }): Promise<PaymentStatusResult>;
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
