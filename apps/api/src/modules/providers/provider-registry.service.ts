import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor } from '@pay2all/auth';
import type { Provider, PrismaClient } from '@pay2all/database';
import {
  type HealthOutcome,
  type PayinProvider,
  payinAdapter,
  type PayoutProvider,
  payoutAdapter,
  type ProviderContext,
  readMetrics,
  recordProbe,
  recordSample,
} from '@pay2all/providers';
import { metrics } from '@pay2all/telemetry';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { PRISMA, REDIS } from '../../infra/tokens';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Builds adapter instances with decrypted credentials at call time. Decrypted values live only in
 * memory for the duration of the call and are never logged or returned.
 */
@Injectable()
export class ProviderRegistryService {
  /** id → code for metric labels (a handful of providers; codes read better than ids on dashboards). */
  private readonly codes = new Map<string, string>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly encryptor: FieldEncryptor,
  ) {}

  credentialAad(providerId: string, environment: string) {
    return `${providerId}:${environment}`;
  }

  async context(provider: Provider): Promise<ProviderContext> {
    const cred = await this.prisma.providerCredential.findUnique({
      where: { providerId_environment: { providerId: provider.id, environment: provider.environment } },
      select: { secretEncrypted: true },
    });
    const credentials = cred ? (JSON.parse(this.encryptor.decrypt(cred.secretEncrypted, this.credentialAad(provider.id, provider.environment))) as Record<string, string>) : {};
    const config = (provider.config ?? {}) as Record<string, unknown>;
    return {
      providerId: provider.id,
      providerCode: provider.code,
      environment: provider.environment,
      credentials: Object.freeze(credentials),
      config: Object.freeze(config),
      requestId: RequestContextStore.get()?.requestId ?? 'system',
      timeoutMs: typeof config.timeout_ms === 'number' ? config.timeout_ms : DEFAULT_TIMEOUT_MS,
    };
  }

  private async load(providerId: string): Promise<Provider> {
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    this.codes.set(provider.id, provider.code);
    return provider;
  }

  async payin(providerId: string): Promise<{ provider: Provider; adapter: PayinProvider }> {
    const provider = await this.load(providerId);
    return { provider, adapter: payinAdapter(provider.adapter, await this.context(provider)) };
  }

  async payout(providerId: string): Promise<{ provider: Provider; adapter: PayoutProvider }> {
    const provider = await this.load(providerId);
    return { provider, adapter: payoutAdapter(provider.adapter, await this.context(provider)) };
  }

  /** Every provider call reports its outcome here; the worker turns samples into status changes. */
  recordOutcome(providerId: string, service: 'PAYIN' | 'PAYOUT', outcome: HealthOutcome, latencyMs: number) {
    const provider = this.codes.get(providerId) ?? providerId;
    metrics.providerCalls.inc({ provider, service, outcome });
    metrics.providerLatency.observe({ provider, service }, latencyMs / 1000);
    return recordSample(this.redis, providerId, service, outcome, latencyMs);
  }

  recordProbe(providerId: string, ok: boolean) {
    return recordProbe(this.redis, providerId, ok);
  }

  metrics(providerId: string, service: 'PAYIN' | 'PAYOUT') {
    return readMetrics(this.redis, providerId, service);
  }
}
