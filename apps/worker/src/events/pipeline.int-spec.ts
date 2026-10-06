import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { newId } from '@pay2all/auth';
import { createConsumerStore, createPrismaClient, type Prisma } from '@pay2all/database';
import { createKafka, EventPublisher, type EventEnvelope, runConsumer, topicFor } from '@pay2all/events';
import { createLogger } from '@pay2all/logger';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import type { Consumer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay } from './outbox-relay';

loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const prisma = createPrismaClient({ url: process.env.TEST_DATABASE_URL!, poolMax: 5 });
const redis = new Redis(`${(process.env.REDIS_URL ?? 'redis://localhost:56379').replace(/\/\d+$/, '')}/1`);
const logger = createLogger({ service: 'test', level: 'silent' });
const kafka = createKafka({ brokers: (process.env.KAFKA_BROKERS ?? 'localhost:59092').split(','), clientId: 'pay2all-test' });
const publisher = new EventPublisher(kafka);
const run = randomUUID().slice(0, 8);
const consumers: Consumer[] = [];

const until = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for condition');
};

/** Read every message currently on a topic from the beginning. */
async function readTopic(topic: string, expected: number): Promise<{ key: string; value: EventEnvelope; headers: Record<string, string> }[]> {
  const out: { key: string; value: EventEnvelope; headers: Record<string, string> }[] = [];
  const c = kafka.consumer({ groupId: `reader-${randomUUID()}` });
  consumers.push(c);
  await c.connect();
  await c.subscribe({ topic, fromBeginning: true });
  await c.run({
    eachMessage: async ({ message }) => {
      out.push({ key: message.key!.toString(), value: JSON.parse(message.value!.toString()) as EventEnvelope, headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])) });
    },
  });
  await until(() => out.length >= expected);
  return out;
}

async function outbox(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown> = {}) {
  const id = newId('outboxEvent');
  await prisma.outboxEvent.create({ data: { id, eventType, aggregateType, aggregateId, payload: payload as Prisma.InputJsonValue, headers: { request_id: `req_${run}` } } });
  return id;
}

beforeAll(async () => {
  await publisher.connect();
});

afterAll(async () => {
  await Promise.allSettled(consumers.map((c) => c.disconnect()));
  await publisher.disconnect();
  await prisma.$disconnect();
  await redis.quit();
});

describe('outbox relay', () => {
  it('publishes unpublished rows in order per aggregate with the full envelope, then marks them', async () => {
    const agg = `it_${run}`;
    const ids = [await outbox(agg, 'A', 'x.one', { n: 1 }), await outbox(agg, 'B', 'x.one', { n: 1 }), await outbox(agg, 'A', 'x.two', { n: 2 }), await outbox(agg, 'A', 'x.three', { n: 3 })];
    // Other rows may be pending in the shared test DB; drain until ours are published.
    const relay = new OutboxRelay(prisma, redis, publisher, logger, { batchSize: 1000 });
    await until(async () => {
      await relay.relayOnce();
      return (await prisma.outboxEvent.count({ where: { id: { in: ids }, publishedAt: null } })) === 0;
    });
    const msgs = await readTopic(topicFor(agg), 4);
    const a = msgs.filter((m) => m.key === 'A').map((m) => m.value.payload.n);
    expect(a).toEqual([1, 2, 3]);
    const first = msgs.find((m) => m.value.event_id === ids[0])!;
    expect(first.value).toMatchObject({ event_type: 'x.one', aggregate_type: agg, aggregate_id: 'A', version: 1, request_id: `req_${run}` });
    expect(first.headers).toMatchObject({ event_id: ids[0], event_type: 'x.one' });
  });

  it('only one relay holds the leader lease', async () => {
    await redis.del('outbox-relay:leader');
    const a = new OutboxRelay(prisma, redis, publisher, logger, { leaseMs: 3_000, idleMs: 50 });
    const b = new OutboxRelay(prisma, redis, publisher, logger, { leaseMs: 3_000, idleMs: 50 });
    a.start();
    await until(() => a.isLeader);
    b.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(b.isLeader).toBe(false);
    await a.stop(); // releases the lease
    await until(() => b.isLeader, 5_000);
    await b.stop();
  });
});

describe('consumer framework', () => {
  it('processes each event once even when it is delivered twice', async () => {
    const topic = topicFor(`it_dedupe_${run}`);
    const seen: string[] = [];
    const group = `g-dedupe-${run}`;
    consumers.push(await runConsumer(kafka, { groupId: group, topics: [topic], handle: async (e) => void seen.push(e.event_id) }, { store: createConsumerStore(prisma), publisher, logger, fromBeginning: true }));
    const env: EventEnvelope = { event_id: `evt_${run}_1`, event_type: 't.dup', aggregate_type: 'it', aggregate_id: 'X', version: 1, occurred_at: new Date().toISOString(), request_id: null, payload: {} };
    await publisher.publish([{ topic, envelope: env }, { topic, envelope: env }, { topic, envelope: { ...env, event_id: `evt_${run}_2` } }]);
    await until(async () => (await prisma.processedEvent.count({ where: { consumerGroup: group } })) === 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.sort()).toEqual([`evt_${run}_1`, `evt_${run}_2`]);
  });

  it('dead-letters a poison message after bounded retries and keeps consuming', async () => {
    const topic = topicFor(`it_poison_${run}`);
    const group = `g-poison-${run}`;
    const ok: string[] = [];
    consumers.push(
      await runConsumer(
        kafka,
        {
          groupId: group,
          topics: [topic],
          maxAttempts: 2,
          handle: async (e) => {
            if (e.payload.poison) throw new Error('boom: cannot process');
            ok.push(e.event_id);
          },
        },
        { store: createConsumerStore(prisma), publisher, logger, fromBeginning: true },
      ),
    );
    const base = { event_type: 't.p', aggregate_type: 'it', aggregate_id: 'P', version: 1, occurred_at: new Date().toISOString(), request_id: null };
    await publisher.publish([{ topic, envelope: { ...base, event_id: `evt_${run}_bad`, payload: { poison: true } } }, { topic, envelope: { ...base, event_id: `evt_${run}_good`, payload: {} } }]);
    await until(() => ok.includes(`evt_${run}_good`));
    const dl = await prisma.deadLetterEvent.findFirstOrThrow({ where: { consumerGroup: group } });
    expect(dl).toMatchObject({ eventId: `evt_${run}_bad`, attempts: 2, topic });
    expect(dl.error).toContain('boom');
    // The failed event is not marked processed, so a requeue will run it again.
    expect(await prisma.processedEvent.count({ where: { consumerGroup: group, eventId: `evt_${run}_bad` } })).toBe(0);
    const dlq = await readTopic(`${topic}.dlq`, 1);
    expect(dlq[0]!.value.event_id).toBe(`evt_${run}_bad`);
    expect(dlq[0]!.headers.dlq_group).toBe(group);
  });
});
