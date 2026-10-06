import { ProviderError } from '../interfaces/errors';
import type {
  BeneficiaryVerification,
  CreatePayoutRequest,
  CreatePayoutResult,
  PayoutProvider,
  PayoutStatusResult,
  ProviderBalance,
  ProviderContext,
  VerifyBeneficiaryRequest,
} from '../interfaces/types';
import { cfg, digits, mockHealthCheck, paise, settings, simulateLatency, ulidTime, verifyMockWebhook } from './shared';

/**
 * Sandbox payout provider. Deterministic and idempotent on the request reference. Outcomes by paise:
 *   .13 → REJECTED before acceptance (safe to fail over)
 *   .99 → unreachable / NOT_ATTEMPTED (safe to fail over)
 *   .77 → timeout after send — AMBIGUOUS (must NOT fail over)
 *   .17 → accepted, later FAILED      .50 → accepted, stays PENDING
 *   .88 → SUCCESS, later REVERSED (bank return)      otherwise accepted → SUCCESS after a delay
 */
export class MockPayoutProvider implements PayoutProvider {
  constructor(private readonly ctx: ProviderContext) {}

  async createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult> {
    await simulateLatency(this.ctx);
    const p = paise(req.amountMinor);
    if (p === 99) throw new ProviderError('NOT_ATTEMPTED', 'ECONNREFUSED', 'Simulated connection refused', this.ctx.providerCode);
    if (p === 13) throw new ProviderError('REJECTED', 'BENEFICIARY_BANK_REJECTED', 'Beneficiary bank is not accepting transfers', this.ctx.providerCode, 422);
    if (p === 77) throw new ProviderError('AMBIGUOUS', 'TIMEOUT', 'Simulated timeout after the request was sent', this.ctx.providerCode);
    if (!req.beneficiary.accountNumber && !req.beneficiary.vpa) throw new ProviderError('REJECTED', 'INVALID_BENEFICIARY', 'Beneficiary account or VPA required', this.ctx.providerCode, 400);
    return { providerReference: `mockpo_${req.amountMinor}_${req.reference}`, status: 'ACCEPTED' };
  }

  async getPayoutStatus(providerReference: string): Promise<PayoutStatusResult> {
    await simulateLatency(this.ctx);
    const match = /^mockpo_(\d+)_(.+)$/.exec(providerReference);
    if (!match) throw new ProviderError('REJECTED', 'NOT_FOUND', 'Unknown payout', this.ctx.providerCode, 404);
    const amountMinor = BigInt(match[1]!);
    const reference = match[2]!;
    const p = paise(amountMinor);
    const delay = settings(this.ctx).autoSuccessAfterMs;
    const age = Date.now() - ulidTime(reference);
    if (p === 50 || age < delay) return { providerReference, status: 'PENDING' };
    if (p === 17) return { providerReference, status: 'FAILED', failureCode: 'ACCOUNT_CLOSED', failureReason: 'Beneficiary account closed' };
    const utr = digits(`utr:${reference}`, 12);
    if (p === 88 && age >= delay * 2) return { providerReference, status: 'REVERSED', utr, failureCode: 'RETURNED', failureReason: 'Credit returned by beneficiary bank' };
    return { providerReference, status: 'SUCCESS', utr, completedAt: new Date(ulidTime(reference) + delay) };
  }

  async verifyBeneficiary(req: VerifyBeneficiaryRequest): Promise<BeneficiaryVerification> {
    await simulateLatency(this.ctx);
    const providerReference = `mockbv_${req.reference}`;
    if (req.accountNumber?.endsWith('0000') || req.vpa?.includes('invalid')) {
      return { status: 'FAILED', providerReference, failureReason: 'Account or VPA does not exist' };
    }
    return { status: 'VERIFIED', providerReference, registeredName: req.name.toUpperCase(), nameMatchScore: 100 };
  }

  async getBalance(): Promise<ProviderBalance> {
    await simulateLatency(this.ctx);
    return { availableMinor: BigInt(cfg(this.ctx, 'balance_minor', '100000000000')), currency: 'INR' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    return verifyMockWebhook(this.ctx, rawBody, headers);
  }

  healthCheck() {
    return mockHealthCheck(this.ctx);
  }
}
