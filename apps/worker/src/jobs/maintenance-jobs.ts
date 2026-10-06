import type { PrismaClient } from '@pay2all/database';
import type { ScheduledJob } from '@pay2all/events';

const RETENTION_DAYS = 14;

/**
 * processed_events only needs to outlive Kafka redelivery (topic retention 7 days by default);
 * keep 14 days and purge daily so the dedupe table stays small.
 */
export function processedEventsCleanupJob(prisma: PrismaClient): ScheduledJob {
  return {
    name: 'processed-events-cleanup',
    dueKey: (now) => now.toISOString().slice(0, 10),
    run: async () => {
      await prisma.processedEvent.deleteMany({ where: { processedAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) } } });
    },
  };
}
