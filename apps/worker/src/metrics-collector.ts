import type { PrismaClient } from '@pay2all/database';
import { metrics } from '@pay2all/telemetry';

const PROVIDER_STATE: Record<string, number> = { ACTIVE: 0, DEGRADED: 1, DOWN: 2, MAINTENANCE: 3, DISABLED: 3 };

/**
 * Pipeline gauges read from the database (docs/OBSERVABILITY.md §2.3). Refreshed on a timer rather
 * than on scrape, so a slow database can never make /metrics time out. All queries hit indexes or
 * small tables.
 */
export async function refreshPipelineGauges(prisma: PrismaClient): Promise<void> {
  const [outbox] = await prisma.$queryRaw<Array<{ n: number; oldest: Date | null }>>`
    SELECT count(*)::int AS n, min(occurred_at) AS oldest FROM outbox_events WHERE published_at IS NULL`;
  metrics.outboxPending.set(outbox?.n ?? 0);
  metrics.outboxOldestAge.set(outbox?.oldest ? Math.max(0, (Date.now() - outbox.oldest.getTime()) / 1000) : 0);
  metrics.deadLetters.set(await prisma.deadLetterEvent.count({ where: { requeuedAt: null } }));
  const providers = await prisma.provider.findMany({ select: { code: true, kind: true, status: true } });
  metrics.providerHealth.reset();
  for (const p of providers) metrics.providerHealth.set({ provider: p.code, service: p.kind }, PROVIDER_STATE[p.status] ?? 3);
}
