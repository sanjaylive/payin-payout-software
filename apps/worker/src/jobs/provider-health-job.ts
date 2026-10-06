import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import type { PrismaClient, Provider } from '@pay2all/database';
import type { Logger } from '@pay2all/logger';
import {
  ADAPTERS,
  type BreakerStatus,
  type HealthMetrics,
  nextAutoStatus,
  type ProviderContext,
  readMetrics,
  readProbes,
  recordProbe,
  type RedisLike,
} from '@pay2all/providers';
import type { ScheduledJob } from './scheduler';

const AUTO_STATES: BreakerStatus[] = ['ACTIVE', 'DEGRADED', 'DOWN'];

/** Combine payin + payout traffic into the worst-case view used by the breaker. */
function worst(a: HealthMetrics | null, b: HealthMetrics | null): HealthMetrics {
  const xs = [a, b].filter((m): m is HealthMetrics => Boolean(m));
  if (xs.length === 1) return xs[0]!;
  const [x, y] = xs as [HealthMetrics, HealthMetrics];
  const errRate = (m: HealthMetrics) => (m.requests ? (m.failures + m.timeouts) / m.requests : 0);
  return errRate(x) >= errRate(y) ? x : y;
}

function context(provider: Provider, encryptor: FieldEncryptor, secretEncrypted: string | null): ProviderContext {
  const credentials = secretEncrypted ? (JSON.parse(encryptor.decrypt(secretEncrypted, `${provider.id}:${provider.environment}`)) as Record<string, string>) : {};
  const config = provider.config as Record<string, unknown>;
  return { providerId: provider.id, providerCode: provider.code, environment: provider.environment, credentials, config, requestId: 'health-probe', timeoutMs: typeof config.timeout_ms === 'number' ? config.timeout_ms : 10_000 };
}

/**
 * Provider health: the single writer of AUTO status changes (ACTIVE ⇄ DEGRADED ⇄ DOWN).
 * MANUAL statuses (MAINTENANCE, DISABLED) are never touched. Every minute: probe, evaluate, apply.
 */
export function providerHealthJob(prisma: PrismaClient, redis: RedisLike, logger: Logger, encryptionKey: string, keyId: string): ScheduledJob {
  const encryptor = new FieldEncryptor(createKeyring(keyId, { [keyId]: encryptionKey }));
  return {
    name: 'provider-health',
    dueKey: (now) => now.toISOString().slice(0, 16), // once per minute
    async run(now) {
      const providers = await prisma.provider.findMany({ where: { statusSource: 'AUTO', status: { in: AUTO_STATES } } });
      for (const provider of providers) {
        const cred = await prisma.providerCredential.findUnique({
          where: { providerId_environment: { providerId: provider.id, environment: provider.environment } },
          select: { secretEncrypted: true },
        });
        const factory = ADAPTERS[provider.adapter];
        try {
          const ctx = context(provider, encryptor, cred?.secretEncrypted ?? null);
          const adapter = factory?.payin?.(ctx) ?? factory?.payout?.(ctx);
          if (!adapter) throw new Error(`No adapter for ${provider.adapter}`);
          await adapter.healthCheck();
          await recordProbe(redis, provider.id, true);
        } catch {
          await recordProbe(redis, provider.id, false);
        }

        const since = provider.statusChangedAt;
        const metrics = worst(
          provider.kind !== 'PAYOUT' ? await readMetrics(redis, provider.id, 'PAYIN', now, since) : null,
          provider.kind !== 'PAYIN' ? await readMetrics(redis, provider.id, 'PAYOUT', now, since) : null,
        );
        const next = nextAutoStatus(provider.status as BreakerStatus, metrics, await readProbes(redis, provider.id));
        if (next === provider.status) continue;

        const errorPct = metrics.requests ? Math.round(((metrics.failures + metrics.timeouts) / metrics.requests) * 100) : 0;
        const reason = `Automatic: ${metrics.requests} requests, ${errorPct}% errors, p95 ${metrics.p95LatencyMs ?? '—'}ms`;
        const applied = await prisma.$transaction(async (tx) => {
          // Optimistic: skip if an operator changed the provider meanwhile.
          const updated = await tx.provider.updateMany({
            where: { id: provider.id, version: provider.version, statusSource: 'AUTO' },
            data: { status: next, statusReason: reason, statusChangedAt: now, version: { increment: 1 } },
          });
          if (updated.count !== 1) return false;
          await tx.auditLog.create({
            data: { id: newId('auditLog'), actorType: 'SYSTEM', action: 'provider.status_changed', resourceType: 'provider', resourceId: provider.id, oldValue: { status: provider.status }, newValue: { status: next }, metadata: { reason, source: 'AUTO' } },
          });
          await tx.outboxEvent.create({
            data: { id: newId('outboxEvent'), eventType: 'provider.status_changed', aggregateType: 'provider', aggregateId: provider.id, payload: { provider_id: provider.id, from: provider.status, to: next, source: 'AUTO' } },
          });
          return true;
        });
        if (applied) logger.warn({ provider: provider.code, from: provider.status, to: next, reason }, 'Provider status changed');
      }
    },
  };
}

/** Persist windowed health metrics every 5 minutes for history/charts. */
export function providerSnapshotJob(prisma: PrismaClient, redis: RedisLike): ScheduledJob {
  return {
    name: 'provider-health-snapshot',
    dueKey: (now) => (now.getUTCMinutes() % 5 === 0 ? now.toISOString().slice(0, 16) : null),
    async run(now) {
      const providers = await prisma.provider.findMany({ where: { status: { not: 'DISABLED' } } });
      const rows = [];
      for (const p of providers) {
        for (const service of ['PAYIN', 'PAYOUT'] as const) {
          if ((service === 'PAYIN' && p.kind === 'PAYOUT') || (service === 'PAYOUT' && p.kind === 'PAYIN')) continue;
          const m = await readMetrics(redis, p.id, service, now);
          rows.push({
            id: newId('providerHealth'),
            providerId: p.id,
            service,
            windowStart: new Date(now.getTime() - m.windowMinutes * 60_000),
            windowEnd: now,
            requests: m.requests,
            successes: m.successes,
            failures: m.failures,
            timeouts: m.timeouts,
            avgLatencyMs: m.avgLatencyMs,
            p95LatencyMs: m.p95LatencyMs,
            p99LatencyMs: m.p99LatencyMs,
            status: p.status,
            lastSuccessAt: m.lastSuccessAt,
            lastFailureAt: m.lastFailureAt,
          });
        }
      }
      if (rows.length) await prisma.providerHealthSnapshot.createMany({ data: rows });
    },
  };
}
