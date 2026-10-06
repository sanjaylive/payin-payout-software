import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';

/** Shape of a dead letter (mirrors `DeadLetter` in @pay2all/events; kept structural to avoid a dependency). */
interface DeadLetterInput {
  consumerGroup: string;
  topic: string;
  partition: number;
  offset: string;
  envelope: { event_id?: string; event_type?: string; aggregate_id?: string } | { raw: string };
  error: string;
  attempts: number;
}

/**
 * Prisma implementation of the consumer framework's store: `processed_events` dedupe in the same
 * transaction as the handler's side effects, and a DB copy of every dead letter for the dashboard.
 */
export function createConsumerStore(prisma: PrismaClient) {
  return {
    async processOnce(consumerGroup: string, eventId: string, work: (tx: unknown) => Promise<void>): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO processed_events (consumer_group, event_id) VALUES (${consumerGroup}, ${eventId}) ON CONFLICT DO NOTHING`;
        if (inserted === 0) return false;
        await work(tx);
        return true;
      });
    },
    async deadLetter(l: DeadLetterInput): Promise<void> {
      const env = l.envelope as { event_id?: string; event_type?: string; aggregate_id?: string };
      await prisma.deadLetterEvent.create({
        data: {
          id: `dlq_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
          consumerGroup: l.consumerGroup,
          topic: l.topic,
          partition: l.partition,
          offset: l.offset,
          eventId: env.event_id ?? null,
          eventType: env.event_type ?? null,
          aggregateId: env.aggregate_id ?? null,
          error: l.error,
          attempts: l.attempts,
          envelope: l.envelope,
        },
      });
    },
  };
}
