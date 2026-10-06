import { httpJson, verifyHmac } from '../http/client';
import { ProviderError } from '../interfaces/errors';
import type {
  BeneficiaryVerification,
  CreatePaymentRequest,
  CreatePaymentResult,
  CreatePayoutRequest,
  CreatePayoutResult,
  HealthCheckResult,
  PayinProvider,
  PaymentProviderStatus,
  PaymentStatusResult,
  PayoutProvider,
  PayoutProviderStatus,
  PayoutStatusResult,
  ProviderBalance,
  ProviderContext,
  RefundRequest,
  RefundResult,
  VerifyBeneficiaryRequest,
  WebhookVerification,
} from '../interfaces/types';

/**
 * "Provider A" — integration TEMPLATE for an HMAC-signed REST PSP offering collections and
 * disbursements. Endpoint paths and field names illustrate the mapping pattern; replace them with a
 * real partner's API spec before enabling. Disabled by default.
 */
const PAYIN_STATUS: Record<string, PaymentProviderStatus> = { created: 'PENDING', pending: 'PENDING', captured: 'SUCCESS', paid: 'SUCCESS', failed: 'FAILED', expired: 'EXPIRED' };
const PAYOUT_STATUS: Record<string, PayoutProviderStatus> = { queued: 'ACCEPTED', processing: 'PENDING', processed: 'SUCCESS', failed: 'FAILED', reversed: 'REVERSED' };

export class ProviderAAdapter implements PayinProvider, PayoutProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const baseUrl = this.ctx.config.base_url;
    const keyId = this.ctx.credentials.api_key;
    const secret = this.ctx.credentials.api_secret;
    if (typeof baseUrl !== 'string' || !keyId || !secret) {
      throw new ProviderError('CONFIGURATION', 'MISSING_CONFIG', 'provider-a requires base_url, api_key and api_secret', this.ctx.providerCode);
    }
    return httpJson<T>({
      providerCode: this.ctx.providerCode,
      baseUrl,
      method,
      path,
      body,
      timeoutMs: this.ctx.timeoutMs,
      requestId: this.ctx.requestId,
      signing: { keyId, secret, keyHeader: 'X-PA-Key', timestampHeader: 'X-PA-Timestamp', signatureHeader: 'X-PA-Signature' },
    });
  }

  private status<T>(map: Record<string, T>, value: string | undefined): T {
    const mapped = value ? map[value.toLowerCase()] : undefined;
    if (!mapped) throw new ProviderError('AMBIGUOUS', 'UNKNOWN_STATUS', `Unrecognised provider status "${value}"`, this.ctx.providerCode);
    return mapped;
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const { body } = await this.call<{ id: string; status: string; qr_string?: string; intent_url?: string; short_url?: string }>('POST', '/v1/collections', {
      merchant_reference: req.reference,
      amount: req.amountMinor.toString(),
      currency: req.currency,
      channel: req.method,
      customer: req.customer,
      expire_by: Math.floor(req.expiresAt.getTime() / 1000),
    });
    return { providerOrderId: body.id, status: this.status(PAYIN_STATUS, body.status), qrPayload: body.qr_string, upiIntent: body.intent_url, paymentLink: body.short_url };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { body } = await this.call<{ id: string; status: string; amount?: string; txn_id?: string; utr?: string; rrn?: string; payer_vpa?: string; error_description?: string }>('GET', `/v1/collections/${encodeURIComponent(providerOrderId)}`);
    return {
      providerOrderId: body.id,
      status: this.status(PAYIN_STATUS, body.status),
      amountMinor: body.amount ? BigInt(body.amount) : undefined,
      providerTransactionId: body.txn_id,
      utr: body.utr,
      rrn: body.rrn,
      payerVpa: body.payer_vpa,
      failureReason: body.error_description,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const { body } = await this.call<{ id: string; status: string }>('POST', `/v1/collections/${encodeURIComponent(req.providerOrderId)}/refunds`, { merchant_reference: req.reference, amount: req.amountMinor.toString() });
    const status = body.status === 'processed' ? 'SUCCESS' : body.status === 'failed' ? 'FAILED' : 'PENDING';
    return { providerRefundId: body.id, status };
  }

  async createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult> {
    const { body } = await this.call<{ id: string; status: string; utr?: string; failure_reason?: string }>('POST', '/v1/disbursements', {
      // Idempotency: the provider de-duplicates on reference_id.
      reference_id: req.reference,
      amount: req.amountMinor.toString(),
      mode: req.mode,
      purpose: req.purpose,
      fund_account: { name: req.beneficiary.name, account_number: req.beneficiary.accountNumber, ifsc: req.beneficiary.ifsc, vpa: req.beneficiary.vpa },
      narration: req.narration,
    });
    return { providerReference: body.id, status: this.status(PAYOUT_STATUS, body.status), utr: body.utr, failureReason: body.failure_reason };
  }

  async getPayoutStatus(providerReference: string): Promise<PayoutStatusResult> {
    const { body } = await this.call<{ id: string; status: string; utr?: string; failure_reason?: string }>('GET', `/v1/disbursements/${encodeURIComponent(providerReference)}`);
    return { providerReference: body.id, status: this.status(PAYOUT_STATUS, body.status), utr: body.utr, failureReason: body.failure_reason };
  }

  async verifyBeneficiary(req: VerifyBeneficiaryRequest): Promise<BeneficiaryVerification> {
    const { body } = await this.call<{ id: string; status: string; registered_name?: string; name_match_score?: number }>('POST', '/v1/accounts/verify', {
      reference_id: req.reference,
      account_number: req.accountNumber,
      ifsc: req.ifsc,
      vpa: req.vpa,
      name: req.name,
    });
    return { providerReference: body.id, status: body.status === 'valid' ? 'VERIFIED' : body.status === 'pending' ? 'PENDING' : 'FAILED', registeredName: body.registered_name, nameMatchScore: body.name_match_score };
  }

  async getBalance(): Promise<ProviderBalance> {
    const { body } = await this.call<{ available: string }>('GET', '/v1/balance');
    return { availableMinor: BigInt(body.available), currency: 'INR' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const secret = this.ctx.credentials.webhook_secret;
    if (!secret || !verifyHmac(secret, rawBody, headers['x-pa-webhook-signature'])) return { valid: false, reason: 'signature mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as { id: string; event: string; payload: { id: string; merchant_reference?: string; reference_id?: string; status: string; amount?: string; utr?: string; rrn?: string } };
    const kind = body.event.startsWith('disbursement') ? 'payout.status' : body.event.startsWith('refund') ? 'refund.status' : 'payment.status';
    return {
      valid: true,
      event: {
        externalEventId: body.id,
        type: kind,
        reference: body.payload.merchant_reference ?? body.payload.reference_id,
        providerOrderId: kind === 'payment.status' ? body.payload.id : undefined,
        providerReference: kind === 'payout.status' ? body.payload.id : undefined,
        status: body.payload.status,
        amountMinor: body.payload.amount ? BigInt(body.payload.amount) : undefined,
        utr: body.payload.utr,
        rrn: body.payload.rrn,
      },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { latencyMs } = await this.call('GET', '/health');
    return { ok: true, latencyMs };
  }
}
