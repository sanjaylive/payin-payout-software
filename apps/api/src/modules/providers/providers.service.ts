import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { ADAPTERS, classify, payinAdapter, payoutAdapter } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { createProviderSchema, providerCredentialsSchema, providerStatusSchema, updateProviderSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from './provider-registry.service';
import { PROVIDER_INCLUDE, presentProvider } from './providers.presenter';

const json = (v: unknown) => v as Prisma.InputJsonValue;

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async health(p: { id: string; kind: string }) {
    const [payin, payout] = await Promise.all([
      p.kind !== 'PAYOUT' ? this.registry.metrics(p.id, 'PAYIN') : null,
      p.kind !== 'PAYIN' ? this.registry.metrics(p.id, 'PAYOUT') : null,
    ]);
    return { payin, payout };
  }

  async list(kind?: 'PAYIN' | 'PAYOUT') {
    const rows = await this.prisma.provider.findMany({
      where: kind ? { kind: { in: [kind, 'BOTH'] } } : {},
      include: PROVIDER_INCLUDE,
      orderBy: [{ status: 'asc' }, { code: 'asc' }],
    });
    return Promise.all(rows.map(async (p) => presentProvider(p, await this.health(p))));
  }

  async get(id: string) {
    const p = await this.prisma.provider.findUnique({ where: { id }, include: PROVIDER_INCLUDE });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    const snapshots = await this.prisma.providerHealthSnapshot.findMany({ where: { providerId: id }, orderBy: { createdAt: 'desc' }, take: 48 });
    return {
      ...presentProvider(p, await this.health(p)),
      snapshots: snapshots.map((s) => ({ service: s.service, window_end: s.windowEnd, requests: s.requests, success_rate: s.requests ? s.successes / s.requests : null, p95_latency_ms: s.p95LatencyMs, status: s.status })),
      adapters: Object.fromEntries(Object.entries(ADAPTERS).map(([k, a]) => [k, { label: a.label, payin: Boolean(a.payin), payout: Boolean(a.payout) }])),
    };
  }

  adapters() {
    return Object.entries(ADAPTERS).map(([key, a]) => ({ key, label: a.label, payin: Boolean(a.payin), payout: Boolean(a.payout), credential_keys: a.credentialKeys }));
  }

  async create(actor: Actor, input: z.output<typeof createProviderSchema>) {
    const adapter = ADAPTERS[input.adapter];
    if (!adapter) throw new AppError(ErrorCode.INVALID_REQUEST, `Unknown adapter "${input.adapter}"`);
    if ((input.kind !== 'PAYOUT' && !adapter.payin) || (input.kind !== 'PAYIN' && !adapter.payout)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `Adapter "${input.adapter}" does not support ${input.kind}`);
    }
    try {
      const p = await this.prisma.$transaction(async (tx) => {
        // New providers start DISABLED until credentials are set and a connection test passes.
        const created = await tx.provider.create({
          data: { id: newId('provider'), code: input.code, name: input.name, kind: input.kind, adapter: input.adapter, environment: input.environment, status: 'DISABLED', statusSource: 'MANUAL', statusReason: 'New provider — configure credentials and enable', capabilities: json(input.capabilities), config: json(input.config), costs: json(input.costs) },
          include: PROVIDER_INCLUDE,
        });
        await this.audit.record({ action: 'provider.created', resourceType: 'provider', resourceId: created.id, organizationId: null, newValue: { code: input.code, adapter: input.adapter, kind: input.kind } }, tx);
        return created;
      });
      return presentProvider(p);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'A provider with this code already exists');
      throw err;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateProviderSchema>) {
    const before = await this.prisma.provider.findUnique({ where: { id }, include: PROVIDER_INCLUDE });
    if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    if (input.environment === 'LIVE' && !before.credentials.some((c) => c.environment === 'LIVE')) {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'Set LIVE credentials before switching the provider to LIVE');
    }
    const p = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.provider.updateMany({
        where: { id, version: before.version },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.capabilities ? { capabilities: json(input.capabilities) } : {}),
          ...(input.config ? { config: json(input.config) } : {}),
          ...(input.costs ? { costs: json(input.costs) } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Provider changed concurrently; reload and retry');
      await this.audit.record({ action: 'provider.updated', resourceType: 'provider', resourceId: id, organizationId: null, oldValue: { environment: before.environment, capabilities: before.capabilities, config: before.config, costs: before.costs }, newValue: input, metadata: { reason: input.reason } }, tx);
      return tx.provider.findUniqueOrThrow({ where: { id }, include: PROVIDER_INCLUDE });
    });
    return presentProvider(p);
  }

  /**
   * Manual operator status. MAINTENANCE/DISABLED are never overridden by the circuit breaker;
   * setting ACTIVE hands the provider back to automatic health management.
   */
  async setStatus(actor: Actor, id: string, input: z.output<typeof providerStatusSchema>) {
    const before = await this.prisma.provider.findUnique({ where: { id }, include: { credentials: true } });
    if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    if (input.status === 'ACTIVE' && !before.credentials.some((c) => c.environment === before.environment)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `Set ${before.environment} credentials before enabling this provider`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.provider.update({
        where: { id },
        data: { status: input.status, statusSource: input.status === 'ACTIVE' ? 'AUTO' : 'MANUAL', statusReason: input.reason, statusChangedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.record({ action: 'provider.status_changed', resourceType: 'provider', resourceId: id, organizationId: null, oldValue: { status: before.status }, newValue: { status: input.status }, metadata: { reason: input.reason, source: 'MANUAL' } }, tx);
      await this.outbox.add(tx, { eventType: 'provider.status_changed', aggregateType: 'provider', aggregateId: id, payload: { provider_id: id, from: before.status, to: input.status, source: 'MANUAL' } });
    });
    return this.get(id);
  }

  /** Write-only credentials: encrypted as one bundle; only key names and last-4 are kept in clear. */
  async setCredentials(actor: Actor, id: string, input: z.output<typeof providerCredentialsSchema>) {
    const provider = await this.prisma.provider.findUnique({ where: { id } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    const allowed = ADAPTERS[provider.adapter]?.credentialKeys ?? [];
    const unknown = Object.keys(input.values).filter((k) => !allowed.includes(k));
    if (unknown.length) throw new AppError(ErrorCode.INVALID_REQUEST, `Unknown credential keys for ${provider.adapter}: ${unknown.join(', ')}`);
    const fingerprints = Object.fromEntries(Object.entries(input.values).map(([k, v]) => [k, `…${v.slice(-4)}`]));
    const secretEncrypted = this.encryptor.encrypt(JSON.stringify(input.values), this.registry.credentialAad(id, input.environment));
    await this.prisma.$transaction(async (tx) => {
      await tx.providerCredential.upsert({
        where: { providerId_environment: { providerId: id, environment: input.environment } },
        create: { id: newId('providerCredential'), providerId: id, environment: input.environment, secretEncrypted, fingerprints, rotatedById: actor.userId },
        update: { secretEncrypted, fingerprints, rotatedAt: new Date(), rotatedById: actor.userId },
      });
      await this.audit.record({ action: 'provider.credentials.rotated', resourceType: 'provider', resourceId: id, organizationId: null, newValue: { environment: input.environment, keys: Object.keys(input.values) } }, tx);
    });
    return { environment: input.environment, fingerprints };
  }

  /** Live connectivity check through the adapter; recorded as a health probe. */
  async testConnection(id: string) {
    const provider = await this.prisma.provider.findUnique({ where: { id } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    const started = Date.now();
    try {
      const ctx = await this.registry.context(provider);
      const adapter = provider.kind === 'PAYOUT' ? payoutAdapter(provider.adapter, ctx) : payinAdapter(provider.adapter, ctx);
      const result = await adapter.healthCheck();
      await this.registry.recordProbe(id, true);
      return { ok: true, latency_ms: result.latencyMs };
    } catch (err) {
      const e = classify(err, provider.code);
      await this.registry.recordProbe(id, false);
      return { ok: false, latency_ms: Date.now() - started, error_kind: e.kind, error_code: e.code, message: e.message };
    }
  }
}
