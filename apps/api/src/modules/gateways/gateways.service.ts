import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, Provider } from '@pay2all/database';
import { classify, type GatewayDefinition, GATEWAYS, gatewayByKey, payinAdapter } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { saveGatewaySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from '../providers/provider-registry.service';

type Env = 'TEST' | 'LIVE';
interface LastTest {
  ok: boolean;
  at: string;
  environment: Env;
  latency_ms: number;
  message?: string;
}

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

/**
 * Hosted payment gateways (docs/PAYMENT_GATEWAYS.md). A super admin enters credentials; the gateway
 * becomes a PAYIN provider (code = gateway key, adapter = gateway key) with a PAYMENT_LINK route, so
 * routing, health, webhooks, polling, refunds and reconciliation all work as for any provider.
 * Credentials are encrypted per environment and never returned (key names and last 4 only).
 */

/** Gateways whose adapter also issues static (any-amount) UPI QR codes (docs/STATIC_QR.md). */
const STATIC_QR_GATEWAYS = new Set(['razorpay']);
@Injectable()
export class GatewaysService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly registry: ProviderRegistryService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  private api(path: string) {
    return `${this.config.env.API_PUBLIC_URL.replace(/\/$/, '')}${path}`;
  }

  private present(g: GatewayDefinition, p: Provider | null, creds: { environment: string; fingerprints: unknown; rotatedAt: Date }[], route: { isActive: boolean; priority: number } | null) {
    const cfg = (p?.config ?? {}) as { last_test?: LastTest };
    return {
      key: g.key,
      name: g.name,
      tagline: g.tagline,
      website: g.website,
      docs_url: g.docsUrl,
      color: g.color,
      methods: g.methods,
      credential_fields: g.credentials,
      webhook_setup: g.webhookSetup,
      refunds_by_api: g.refundsByApi,
      notes: g.notes,
      webhook_url: this.api(`/v1/webhooks/providers/${g.key}`),
      return_url: this.api('/v1/checkout/return/{payment_id}'),
      connection: p
        ? {
            provider_id: p.id,
            environment: p.environment,
            enabled: p.status !== 'DISABLED' && !!route?.isActive,
            status: p.status,
            priority: route?.priority ?? null,
            credentials: Object.fromEntries(creds.map((c) => [c.environment, { fingerprints: c.fingerprints, updated_at: c.rotatedAt }])),
            last_test: cfg.last_test ?? null,
          }
        : null,
    };
  }

  async list(actor: Actor) {
    platformOnly(actor);
    const providers = await this.prisma.provider.findMany({ where: { code: { in: GATEWAYS.map((g) => g.key) } }, include: { credentials: { select: { environment: true, fingerprints: true, rotatedAt: true } }, routes: { where: { service: 'PAYIN', method: 'PAYMENT_LINK', merchantId: null }, select: { isActive: true, priority: true } } } });
    return GATEWAYS.map((g) => {
      const p = providers.find((x) => x.code === g.key) ?? null;
      return this.present(g, p, p?.credentials ?? [], p?.routes[0] ?? null);
    });
  }

  private definition(key: string) {
    const g = gatewayByKey(key);
    if (!g) throw new AppError(ErrorCode.NOT_FOUND, 'Unknown payment gateway');
    return g;
  }

  /** Create or update the connection; credentials are merged with what's stored for that environment. */
  async save(actor: Actor, key: string, input: z.output<typeof saveGatewaySchema>) {
    platformOnly(actor);
    const g = this.definition(key);
    const allowed = new Set(g.credentials.map((c) => c.key));
    const unknown = Object.keys(input.credentials).filter((k) => !allowed.has(k));
    if (unknown.length) throw new AppError(ErrorCode.INVALID_REQUEST, `Unknown credential fields for ${g.name}: ${unknown.join(', ')}`);

    await this.prisma.$transaction(async (tx) => {
      let p = await tx.provider.findUnique({ where: { code: g.key } });
      if (p && p.adapter !== g.key) throw new AppError(ErrorCode.CONFLICT, `A provider with code "${g.key}" already exists and isn't this gateway`);
      if (!p) {
        p = await tx.provider.create({
          data: {
            id: newId('provider'),
            code: g.key,
            name: g.name,
            kind: 'PAYIN',
            adapter: g.key,
            environment: input.environment,
            status: 'DISABLED',
            statusReason: 'Connected, not enabled yet',
            // Static QR only where the adapter can issue one; it still needs its own route to be used.
            capabilities: { payin_methods: ['PAYMENT_LINK', 'CARD', 'NETBANKING', ...(STATIC_QR_GATEWAYS.has(g.key) ? ['UPI_STATIC_QR'] : [])], min_amount_minor: '100' },
            config: { timeout_ms: 15000 },
          },
        });
      }
      const env = input.environment;
      const existing = await tx.providerCredential.findUnique({ where: { providerId_environment: { providerId: p.id, environment: env } } });
      const current = existing ? (JSON.parse(this.encryptor.decrypt(existing.secretEncrypted, this.registry.credentialAad(p.id, env))) as Record<string, string>) : {};
      const merged = { ...current, ...Object.fromEntries(Object.entries(input.credentials).filter(([, v]) => v !== '')) };
      const missing = g.credentials.filter((c) => !c.optional && !merged[c.key]).map((c) => c.label);
      if (missing.length) throw new AppError(ErrorCode.INVALID_REQUEST, `Enter ${missing.join(', ')}`, missing.map((m) => ({ path: 'credentials', message: `${m} is required` })));
      const changed = Object.keys(input.credentials).filter((k) => input.credentials[k] !== '' && input.credentials[k] !== current[k]);
      if (changed.length || !existing) {
        const fingerprints = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, `…${v.slice(-4)}`]));
        const secretEncrypted = this.encryptor.encrypt(JSON.stringify(merged), this.registry.credentialAad(p.id, env));
        await tx.providerCredential.upsert({
          where: { providerId_environment: { providerId: p.id, environment: env } },
          create: { id: newId('providerCredential'), providerId: p.id, environment: env, secretEncrypted, fingerprints, rotatedById: actor.userId },
          update: { secretEncrypted, fingerprints, rotatedAt: new Date(), rotatedById: actor.userId },
        });
      }
      const envChanged = p.environment !== env;
      // Switching environment or credentials invalidates the last test.
      const cfg = { ...((p.config ?? {}) as Record<string, unknown>) };
      if (envChanged || changed.length) delete cfg.last_test;
      await tx.provider.update({ where: { id: p.id }, data: { environment: env, config: cfg as Prisma.InputJsonValue, version: { increment: 1 } } });
      await this.ensureRoute(tx, p.id, g.name, input.priority, null);
      await this.audit.record({ action: 'gateway.saved', resourceType: 'provider', resourceId: p.id, organizationId: null, newValue: { gateway: g.key, environment: env, credential_keys_changed: changed, priority: input.priority }, metadata: { reason: input.reason, severity: changed.length ? 'HIGH' : 'MEDIUM' } }, tx);
    });
    return this.one(key);
  }

  private async ensureRoute(tx: Prisma.TransactionClient, providerId: string, name: string, priority: number | undefined, active: boolean | null) {
    const route = await tx.providerRoute.findFirst({ where: { providerId, service: 'PAYIN', method: 'PAYMENT_LINK', merchantId: null } });
    if (route) {
      await tx.providerRoute.update({ where: { id: route.id }, data: { ...(priority !== undefined ? { priority } : {}), ...(active !== null ? { isActive: active } : {}), version: { increment: 1 } } });
    } else {
      await tx.providerRoute.create({ data: { id: newId('providerRoute'), name: `${name} — hosted checkout`, service: 'PAYIN', method: 'PAYMENT_LINK', providerId, tier: 'PRIMARY', priority: priority ?? 10, isActive: active ?? false } });
    }
  }

  private async one(key: string) {
    return (await this.list({ organizationType: 'PLATFORM' } as Actor)).find((g) => g.key === key)!;
  }

  private async provider(key: string) {
    this.definition(key);
    const p = await this.prisma.provider.findUnique({ where: { code: key } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Connect this gateway first');
    return p;
  }

  /** Live check with the stored credentials for the selected environment (auth / token / lookup call). */
  async test(actor: Actor, key: string) {
    platformOnly(actor);
    const p = await this.provider(key);
    const started = Date.now();
    let result: LastTest;
    try {
      const r = await payinAdapter(p.adapter, await this.registry.context(p)).healthCheck();
      result = { ok: true, at: new Date().toISOString(), environment: p.environment, latency_ms: r.latencyMs };
      await this.registry.recordProbe(p.id, true);
    } catch (err) {
      const e = classify(err, p.code);
      result = { ok: false, at: new Date().toISOString(), environment: p.environment, latency_ms: Date.now() - started, message: e.message.slice(0, 300) };
      await this.registry.recordProbe(p.id, false);
    }
    await this.prisma.provider.update({ where: { id: p.id }, data: { config: { ...((p.config ?? {}) as Record<string, unknown>), last_test: result } as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ action: 'gateway.tested', resourceType: 'provider', resourceId: p.id, organizationId: null, metadata: { ok: result.ok, environment: p.environment } });
    return result;
  }

  /** Enabling needs a passing test of the current credentials; checkout then offers this gateway. */
  async setEnabled(actor: Actor, key: string, enabled: boolean, reason: string) {
    platformOnly(actor);
    const p = await this.provider(key);
    const last = ((p.config ?? {}) as { last_test?: LastTest }).last_test;
    if (enabled && (!last?.ok || last.environment !== p.environment)) throw new AppError(ErrorCode.INVALID_REQUEST, 'Run a successful connection test with the current credentials before enabling');
    await this.prisma.$transaction(async (tx) => {
      await tx.provider.update({ where: { id: p.id }, data: { status: enabled ? 'ACTIVE' : 'DISABLED', statusSource: 'MANUAL', statusReason: enabled ? null : reason, statusChangedAt: new Date(), version: { increment: 1 } } });
      await this.ensureRoute(tx, p.id, p.name, undefined, enabled);
      await this.audit.record({ action: enabled ? 'gateway.enabled' : 'gateway.disabled', resourceType: 'provider', resourceId: p.id, organizationId: null, metadata: { reason, environment: p.environment, severity: 'HIGH' } }, tx);
    });
    return this.one(key);
  }

  /** Forget the credentials for one environment (the gateway must be disabled first). */
  async removeCredentials(actor: Actor, key: string, environment: Env, reason: string) {
    platformOnly(actor);
    const p = await this.provider(key);
    if (p.status !== 'DISABLED' && p.environment === environment) throw new AppError(ErrorCode.CONFLICT, 'Disable the gateway before removing the credentials it uses');
    await this.prisma.$transaction(async (tx) => {
      await tx.providerCredential.deleteMany({ where: { providerId: p.id, environment } });
      await this.audit.record({ action: 'gateway.credentials_removed', resourceType: 'provider', resourceId: p.id, organizationId: null, metadata: { reason, environment, severity: 'HIGH' } }, tx);
    });
    return this.one(key);
  }

  /** Enabled gateways, for checkout (no secrets). */
  async enabledGateways() {
    const rows = await this.prisma.provider.findMany({ where: { code: { in: GATEWAYS.map((g) => g.key) }, status: { in: ['ACTIVE', 'DEGRADED'] }, routes: { some: { service: 'PAYIN', method: 'PAYMENT_LINK', isActive: true } } }, select: { code: true } });
    return rows.map((r) => gatewayByKey(r.code)!).map((g) => ({ key: g.key, name: g.name, methods: g.methods }));
  }
}
