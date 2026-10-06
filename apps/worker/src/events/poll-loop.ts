import type { Logger } from '@pay2all/logger';

/**
 * A tight polling loop for queue-like tables (deliveries, notifications): runs `work` back-to-back
 * while it finds rows, sleeps `idleMs` when idle, and backs off on errors. Stops gracefully.
 */
export class PollLoop {
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly name: string,
    private readonly work: () => Promise<number>,
    private readonly logger: Logger,
    private readonly idleMs = 1_000,
  ) {}

  start() {
    this.running = (async () => {
      while (!this.stopped) {
        let n = 0;
        try {
          n = await this.work();
        } catch (err) {
          this.logger.error({ err, loop: this.name }, 'Poll loop iteration failed');
          await sleep(5_000);
        }
        if (n === 0) await sleep(this.idleMs);
      }
    })();
  }

  async stop() {
    this.stopped = true;
    await this.running;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
