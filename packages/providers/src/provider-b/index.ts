import { httpJson, verifyHmac } from '../http/client';
import { ProviderError } from '../interfaces/errors';
import type {
  BeneficiaryVerification,
  CreatePayoutRequest,
  CreatePayoutResult,
  HealthCheckResult,
  PayoutProvider,
  PayoutProviderStatus,
  PayoutStatusResult,
  ProviderBalance,
  ProviderContext,
  VerifyBeneficiaryRequest,
  WebhookVerification,
} from '../interfaces/types';

/**
 * "Provider B" — payout-only integration TEMPLATE for a bank API using bearer tokens and a
 * numeric status vocabulary. Disabled by default; replace the mapping with the partner's spec.
 */
const STATUS: Record<string, PayoutProviderStatus> = { '0': 'SUCCESS', '1': 'PENDING', '2': 'FAILED', '3': 'REVERSED', '9': 'ACCEPTED' };

export class ProviderBAdapter implements PayoutProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const baseUrl = this.ctx.config.base_url;
    const token = this.ctx.credentials.access_token;
    if (typeof baseUrl !== 'string' || !token) throw new ProviderError('CONFIGURATION', 'MISSING_CONFIG', 'provider-b requires base_url and access_token', this.ctx.providerCode);
    return httpJson<T>({ providerCode: this.ctx.providerCode, baseUrl, method, path, body, timeoutMs: this.ctx.timeoutMs, requestId: this.ctx.requestId, headers: { Authorization: `Bearer ${token}` } });
  }

  private map(code: string | number | undefined): PayoutProviderStatus {
    const s = STATUS[String(code)];
    if (!s) throw new ProviderError('AMBIGUOUS', 'UNKNOWN_STATUS', `Unrecognised status code ${code}`, this.ctx.providerCode);
    return s;
  }

  async createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult> {
    const { body } = await this.call<{ txnRef: string; statusCode: string; bankRef?: string; reason?: string }>('POST', '/api/transfer', {
      clientRef: req.reference,
      amountPaise: req.amountMinor.toString(),
      channel: req.mode,
      beneficiaryName: req.beneficiary.name,
      beneficiaryAccount: req.beneficiary.accountNumber,
      beneficiaryIfsc: req.beneficiary.ifsc,
      beneficiaryVpa: req.beneficiary.vpa,
      remarks: req.narration ?? req.purpose,
    });
    return { providerReference: body.txnRef, status: this.map(body.statusCode), utr: body.bankRef, failureReason: body.reason };
  }

  async getPayoutStatus(providerReference: string): Promise<PayoutStatusResult> {
    const { body } = await this.call<{ txnRef: string; statusCode: string; bankRef?: string; reason?: string }>('GET', `/api/transfer/${encodeURIComponent(providerReference)}`);
    return { providerReference: body.txnRef, status: this.map(body.statusCode), utr: body.bankRef, failureReason: body.reason };
  }

  async verifyBeneficiary(req: VerifyBeneficiaryRequest): Promise<BeneficiaryVerification> {
    const { body } = await this.call<{ ref: string; valid: boolean; nameAtBank?: string }>('POST', '/api/validate-account', { clientRef: req.reference, account: req.accountNumber, ifsc: req.ifsc, vpa: req.vpa });
    return { providerReference: body.ref, status: body.valid ? 'VERIFIED' : 'FAILED', registeredName: body.nameAtBank };
  }

  async getBalance(): Promise<ProviderBalance> {
    const { body } = await this.call<{ balancePaise: string }>('GET', '/api/balance');
    return { availableMinor: BigInt(body.balancePaise), currency: 'INR' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const secret = this.ctx.credentials.webhook_secret;
    if (!secret || !verifyHmac(secret, rawBody, headers['x-pb-signature'])) return { valid: false, reason: 'signature mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as { notificationId: string; txnRef: string; clientRef: string; statusCode: string; bankRef?: string };
    return { valid: true, event: { externalEventId: body.notificationId, type: 'payout.status', reference: body.clientRef, providerReference: body.txnRef, status: this.map(body.statusCode), utr: body.bankRef } };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { latencyMs } = await this.call('GET', '/api/ping');
    return { ok: true, latencyMs };
  }
}
