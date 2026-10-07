import { metrics } from '@pay2all/telemetry';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@pay2all/database';
import { type EventEnvelope, type EventPublisher, topicFor } from '@pay2all/events';
import type { Logger } from '@pay2all/logger';

interface LeaseStore {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  version: number;
  payload: Record<string, unknown>;
  headers: { request_id?: string | null } | null;
  occurred_at: Date;
}

const LEASE_KEY = 'outbox-relay:leader';
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function toEnvelope(r: OutboxRow): EventEnvelope {
  return {
    event_id: r.id,
    event_type: r.event_type,
    aggregate_type: r.aggregate_type,
    aggregate_id: r.aggregate_id,
    version: r.version,
    occurred_at: new Date(r.occurred_at).toISOString(),
    request_id: r.headers?.request_id ?? null,
    payload: r.payload,
  };
}

/**
 * Transactional-outbox relay (docs/ARCHITECTURE.md §8). Exactly one replica relays at a time (Redis
 * lease), which keeps events of one aggregate in commit order on its partition; the others stand by
 * and take over within one lease period. Each batch is published (acks=all, idempotent producer)
 * and marked inside the same DB transaction that locked it, so a crash republishes — never loses —
 * and consumers dedupe on event_id.
 */
export class OutboxRelay {
  private readonly id = randomUUID();
  private leader = false;
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: LeaseStore,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly opts: { batchSize?: number; idleMs?: number; leaseMs?: number } = {},
  ) {}

  get isLeader() {
    return this.leader;
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    if (this.leader) await this.redis.eval(RELEASE, 1, LEASE_KEY, this.id).catch(() => undefined);
  }

  private async holdLease(): Promise<boolean> {
    const ms = this.opts.leaseMs ?? 15_000;
    if (this.leader) {
      this.leader = (await this.redis.eval(RENEW, 1, LEASE_KEY, this.id, ms)) === 1;
      if (!this.leader) this.logger.warn({ relay: this.id }, 'Outbox relay lost its lease');
    } else {
      this.leader = (await this.redis.set(LEASE_KEY, this.id, 'PX', ms, 'NX')) === 'OK';
      if (this.leader) this.logger.info({ relay: this.id }, 'Outbox relay is now the leader');
    }
    return this.leader;
  }

  private async run(): Promise<void> {
    let lastRenew = 0;
    while (!this.stopped) {
      let published = 0;
      try {
        if (Date.now() - lastRenew > (this.opts.leaseMs ?? 15_000) / 3 || !this.leader) {
          await this.holdLease();
          lastRenew = Date.now();
        }
        if (this.leader) published = await this.relayOnce();
      } catch (err) {
        this.logger.error({ err }, 'Outbox relay iteration failed');
        await sleep(2_000);
      }
      if (published === 0) await sleep(this.opts.idleMs ?? 250);
    }
  }

  /** Publish one batch. Returns the number of events published. */
  async relayOnce(): Promise<number> {
    const limit = this.opts.batchSize ?? 500;
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_type, aggregate_type, aggregate_id, version, payload, headers, occurred_at
            FROM outbox_events WHERE published_at IS NULL
           ORDER BY occurred_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return 0;
        const ids = rows.map((r) => r.id);
        try {
          await this.publisher.publish(rows.map((r) => ({ topic: topicFor(r.aggregate_type), envelope: toEnvelope(r) })));
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
          await tx.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: message } });
          this.logger.error({ err, count: ids.length }, 'Outbox publish failed; will retry');
          return 0;
        }
        await tx.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { publishedAt: new Date(), lastError: null } });
        metrics.outboxPublished.inc(ids.length);
        return ids.length;
      },
      { timeout: 60_000, maxWait: 5_000 },
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
