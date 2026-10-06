import { type Consumer, type IHeaders, Kafka, type KafkaConfig, logLevel, type Producer } from 'kafkajs';
import { dlqTopicFor, type EventEnvelope } from './topics';

/** Minimal structural logger so this package stays dependency-free. */
export interface EventLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface KafkaOptions {
  brokers: string[];
  clientId: string;
  /** Replication factor for auto-provisioned topics (1 in dev, ≥ 3 in production). */
  replicationFactor?: number;
  partitions?: number;
}

export function createKafka(opts: KafkaOptions): Kafka {
  const config: KafkaConfig = { clientId: opts.clientId, brokers: opts.brokers, logLevel: logLevel.NOTHING, retry: { retries: 5, initialRetryTime: 200 } };
  return new Kafka(config);
}

/**
 * Idempotent producer (acks=all, max one in-flight request — kafkajs' requirement for idempotence),
 * so a relay retry of the same batch can't duplicate on the broker. Consumers dedupe anyway.
 */
export class EventPublisher {
  private readonly producer: Producer;
  private readonly known = new Set<string>();
  private connected = false;

  constructor(
    private readonly kafka: Kafka,
    private readonly opts: Pick<KafkaOptions, 'replicationFactor' | 'partitions'> = {},
  ) {
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
  }

  /** Create missing topics (and their DLQs). Safe to call repeatedly. */
  async ensureTopics(topics: string[]): Promise<void> {
    const missing = topics.flatMap((t) => [t, dlqTopicFor(t)]).filter((t) => !this.known.has(t) && !t.endsWith('.dlq.dlq'));
    if (!missing.length) return;
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const create = [...new Set(missing)].filter((t) => !existing.has(t));
      if (create.length) {
        await admin.createTopics({
          waitForLeaders: true,
          topics: create.map((topic) => ({ topic, numPartitions: topic.endsWith('.dlq') ? 3 : (this.opts.partitions ?? 12), replicationFactor: this.opts.replicationFactor ?? 1 })),
        });
      }
      for (const t of missing) this.known.add(t);
    } finally {
      await admin.disconnect();
    }
  }

  /** Publish envelopes; resolves only when every message is acknowledged by all in-sync replicas. */
  async publish(items: { topic: string; envelope: EventEnvelope; headers?: Record<string, string> }[]): Promise<void> {
    if (!items.length) return;
    await this.connect();
    await this.ensureTopics([...new Set(items.map((i) => i.topic))]);
    const byTopic = new Map<string, { key: string; value: string; headers: IHeaders }[]>();
    for (const i of items) {
      const list = byTopic.get(i.topic) ?? [];
      list.push({
        key: i.envelope.aggregate_id,
        value: JSON.stringify(i.envelope),
        headers: { event_id: i.envelope.event_id, event_type: i.envelope.event_type, ...(i.envelope.request_id ? { request_id: i.envelope.request_id } : {}), ...i.headers },
      });
      byTopic.set(i.topic, list);
    }
    await this.producer.sendBatch({ acks: -1, topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
  }
}

// ---- Consumers ---------------------------------------------------------------------------------

export interface DeadLetter {
  consumerGroup: string;
  topic: string;
  partition: number;
  offset: string;
  envelope: EventEnvelope | { raw: string };
  error: string;
  attempts: number;
}

export interface ConsumerStore {
  /**
   * Record (group, eventId) and run `work` in ONE database transaction. Resolves false (without
   * running `work`) when the event was already processed — the at-least-once dedupe.
   */
  processOnce(consumerGroup: string, eventId: string, work: (tx: unknown) => Promise<void>): Promise<boolean>;
  deadLetter(letter: DeadLetter): Promise<void>;
}

export interface ConsumerSpec {
  groupId: string;
  topics: string[];
  /**
   * `store` (default): dedupe through processed_events in the handler's transaction.
   * `handler`: the handler is idempotent on its own (e.g. a conditional claim) and gets no tx.
   */
  idempotency?: 'store' | 'handler';
  /** Only these event types reach the handler (others are acknowledged and skipped). */
  eventTypes?: string[];
  maxAttempts?: number;
  handle(envelope: EventEnvelope, tx: unknown): Promise<void>;
}

const RETRY_DELAYS_MS = [200, 1_000, 3_000, 8_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Consumer framework: parse → (skip foreign types) → dedupe + handle in one DB transaction →
 * bounded in-process retries with backoff → dead-letter (`<topic>.dlq` + DB row) → commit offset.
 * A poison message can therefore never block its partition for more than ~12 s.
 */
export async function runConsumer(kafka: Kafka, spec: ConsumerSpec, deps: { store: ConsumerStore; publisher: EventPublisher; logger: EventLogger; fromBeginning?: boolean }): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: spec.groupId, allowAutoTopicCreation: false, sessionTimeout: 30_000, heartbeatInterval: 3_000 });
  await deps.publisher.ensureTopics(spec.topics);
  await consumer.connect();
  await consumer.subscribe({ topics: spec.topics, fromBeginning: deps.fromBeginning ?? false });
  const maxAttempts = spec.maxAttempts ?? RETRY_DELAYS_MS.length + 1;
  await consumer.run({
    autoCommit: true,
    eachMessage: async (payload) => {
      const { topic, partition, message } = payload;
      const raw = message.value?.toString('utf8') ?? '';
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(raw) as EventEnvelope;
        if (!envelope.event_id || !envelope.event_type) throw new Error('Not an event envelope');
      } catch (err) {
        await deadLetter({ raw: raw.slice(0, 10_000) }, err, 1);
        return;
      }
      if (spec.eventTypes && !spec.eventTypes.includes(envelope.event_type)) return;

      for (let attempt = 1; ; attempt++) {
        try {
          if (spec.idempotency === 'handler') await spec.handle(envelope, undefined);
          else await deps.store.processOnce(spec.groupId, envelope.event_id, (tx) => spec.handle(envelope, tx));
          return;
        } catch (err) {
          if (attempt >= maxAttempts) {
            await deadLetter(envelope, err, attempt);
            return;
          }
          deps.logger.warn({ err, groupId: spec.groupId, eventId: envelope.event_id, attempt }, 'Event handler failed; retrying');
          await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 8_000);
          await payload.heartbeat();
        }
      }

      async function deadLetter(env: EventEnvelope | { raw: string }, err: unknown, attempts: number) {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
        const letter: DeadLetter = { consumerGroup: spec.groupId, topic, partition, offset: message.offset, envelope: env, error, attempts };
        // DLQ topic first: if it fails we throw, the offset is not committed and kafkajs retries.
        if ('event_id' in env) await deps.publisher.publish([{ topic: dlqTopicFor(topic), envelope: env, headers: { dlq_error: error.slice(0, 200), dlq_group: spec.groupId, dlq_source: `${topic}/${partition}/${message.offset}` } }]);
        await deps.store.deadLetter(letter);
        deps.logger.error({ groupId: spec.groupId, topic, partition, offset: message.offset, eventId: 'event_id' in env ? env.event_id : null, attempts, error }, 'Event dead-lettered');
      }
    },
  });
  return consumer;
}
