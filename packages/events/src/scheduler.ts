/** Minimal logger/redis shapes so this package stays dependency-free. */
interface JobLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
interface ClaimStore {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface ScheduledJob {
  name: string;
  /** Returns a run key for "now" (e.g. the hour or day) or null if the job isn't due. */
  dueKey(now: Date): string | null;
  run(now: Date): Promise<void>;
  /** How long the run-key claim lives (default 7 days). Short for high-frequency jobs. */
  claimTtlSeconds?: number;
}

/** Run key for a job that should run every `seconds` (e.g. `everySeconds(15)`). */
export function everySeconds(seconds: number): (now: Date) => string {
  return (now) => String(Math.floor(now.getTime() / (seconds * 1000)));
}

/**
 * Minimal distributed scheduler: every replica ticks, but a job runs once per run key because the
 * first replica to `SET NX` the key wins. Jobs must be idempotent anyway (they are).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private readonly redis: ClaimStore,
    private readonly logger: JobLogger,
    private readonly jobs: ScheduledJob[],
    private readonly tickMs = 30_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.safeTick(), this.tickMs);
    void this.safeTick();
  }

  /** A failing tick (e.g. Redis briefly unavailable) is logged and retried next tick — never fatal. */
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error({ err }, 'Scheduler tick failed');
    }
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    return new Promise((resolve) => {
      const wait = () => (this.running.size === 0 ? resolve() : setTimeout(wait, 100));
      wait();
    });
  }

  async tick(now = new Date()): Promise<void> {
    for (const job of this.jobs) {
      const key = job.dueKey(now);
      if (!key || this.running.has(job.name)) continue;
      const claimed = await this.redis.set(`job:${job.name}:${key}`, '1', 'EX', job.claimTtlSeconds ?? 7 * 24 * 3600, 'NX');
      if (claimed !== 'OK') continue;
      this.running.add(job.name);
      const started = Date.now();
      job
        .run(now)
        .then(() => this.logger.info({ job: job.name, key, ms: Date.now() - started }, 'Job completed'))
        .catch((err: unknown) => {
          this.logger.error({ err, job: job.name, key }, 'Job failed');
          // Release the claim so another tick/replica retries.
          void this.redis.del(`job:${job.name}:${key}`);
        })
        .finally(() => this.running.delete(job.name));
    }
  }
}
