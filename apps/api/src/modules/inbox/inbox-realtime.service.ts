import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import { Client } from 'pg';
import { ApiConfig } from '../../config/api-config';
import type { Actor } from '../auth/actor';
import { InboxService } from './inbox.service';

const CHANNEL = 'inbox_notification';
const HEARTBEAT_MS = 25_000;
/** Streams are recycled so a revoked session can't keep listening; the client reconnects at once. */
const MAX_STREAM_MS = 10 * 60_000;
const MAX_STREAMS_PER_USER = 10;

interface Stream {
  organizationId: string;
  res: Response;
}

/**
 * Real-time bell (docs/NOTIFICATIONS.md §3). One dedicated Postgres connection per API node
 * LISTENs on `inbox_notification`. NOTIFY is transactional, so only committed notifications arrive;
 * each is pushed over Server-Sent Events to that user's open tabs on this node. No polling. If the
 * LISTEN connection drops, every stream is told to resync (refetch) once it is back.
 */
@Injectable()
export class InboxRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxRealtimeService.name);
  private readonly streams = new Map<string, Set<Stream>>();
  private client: Client | null = null;
  private stopped = false;
  private retryMs = 1_000;

  constructor(
    private readonly config: ApiConfig,
    private readonly inbox: InboxService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect(false);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const set of this.streams.values()) for (const s of set) s.res.end();
    this.streams.clear();
    await this.client?.end().catch(() => undefined);
  }

  private async connect(isReconnect: boolean): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.env.DATABASE_LISTEN_URL || this.config.env.DATABASE_URL, application_name: 'pay2all-inbox-listen' });
    client.on('notification', (msg) => void this.onNotification(msg.payload));
    client.on('error', (err) => {
      this.logger.warn({ err }, 'Inbox LISTEN connection error; reconnecting');
      void this.reconnect(client);
    });
    client.on('end', () => void this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.retryMs = 1_000;
      if (isReconnect) this.broadcast('resync', {});
    } catch (err) {
      this.logger.warn({ err }, 'Inbox LISTEN unavailable; retrying');
      await client.end().catch(() => undefined);
      setTimeout(() => void this.connect(true), this.retryMs).unref();
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    }
  }

  private async reconnect(client: Client) {
    if (this.stopped || this.client !== client) return;
    this.client = null;
    await client.end().catch(() => undefined);
    setTimeout(() => void this.connect(true), this.retryMs).unref();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  private async onNotification(payload: string | undefined) {
    if (!payload) return;
    let msg: { id?: string; user_id?: string };
    try {
      msg = JSON.parse(payload) as typeof msg;
    } catch {
      return;
    }
    const set = msg.user_id ? this.streams.get(msg.user_id) : undefined;
    if (!set?.size || !msg.id) return;
    for (const orgId of new Set([...set].map((s) => s.organizationId))) {
      const n = await this.inbox.forPush(msg.user_id!, orgId, msg.id).catch(() => null);
      if (!n) continue;
      for (const s of set) if (s.organizationId === orgId) write(s.res, 'notification', n, n.id);
    }
  }

  private broadcast(event: string, data: unknown) {
    for (const set of this.streams.values()) for (const s of set) write(s.res, event, data);
  }

  /** Open an SSE stream for the actor; resolves when it closes. */
  async open(actor: Actor, res: Response): Promise<void> {
    const set = this.streams.get(actor.userId) ?? new Set<Stream>();
    if (set.size >= MAX_STREAMS_PER_USER) {
      // Oldest tab loses its stream (it will reconnect if still open).
      const oldest = set.values().next().value;
      oldest?.res.end();
      if (oldest) set.delete(oldest);
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const stream: Stream = { organizationId: actor.organizationId, res };
    set.add(stream);
    this.streams.set(actor.userId, set);
    write(res, 'ready', { ...(await this.inbox.unreadCount(actor)), live: this.client !== null });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const lifetime = setTimeout(() => res.end(), MAX_STREAM_MS);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        set.delete(stream);
        if (!set.size) this.streams.delete(actor.userId);
        resolve();
      };
      res.on('close', done);
      res.on('finish', done);
    });
  }

  /** For tests and metrics. */
  get openStreams(): number {
    let n = 0;
    for (const s of this.streams.values()) n += s.size;
    return n;
  }
}

function write(res: Response, event: string, data: unknown, id?: string) {
  if (res.writableEnded) return;
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
