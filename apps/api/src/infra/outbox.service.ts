import { Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { DbClient, Prisma } from '@pay2all/database';
import { RequestContextStore } from '../common/context/request-context';

export interface OutboxMessage {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  version?: number;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox writer (docs/ARCHITECTURE.md §8). Must be called with the same transaction
 * client as the business change, so the event exists if and only if the change committed. The worker
 * relay (Phase 7) publishes rows to Kafka.
 */
@Injectable()
export class OutboxService {
  async add(tx: DbClient, message: OutboxMessage): Promise<string> {
    const id = newId('outboxEvent');
    const ctx = RequestContextStore.get();
    await tx.outboxEvent.create({
      data: {
        id,
        eventType: message.eventType,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        version: message.version ?? 1,
        payload: message.payload as Prisma.InputJsonValue,
        headers: { request_id: ctx?.requestId ?? null, actor_id: ctx?.actor?.userId ?? null },
      },
    });
    return id;
  }
}
