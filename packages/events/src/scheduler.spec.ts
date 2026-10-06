import { describe, expect, it, vi } from 'vitest';
import { everySeconds, Scheduler } from './scheduler';

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('Scheduler', () => {
  it('runs a job once per run key across replicas', async () => {
    const claims = new Set<string>();
    const store = {
      set: vi.fn(async (k: string) => (claims.has(k) ? null : (claims.add(k), 'OK'))),
      del: vi.fn(async () => 1),
    };
    const run = vi.fn(async () => undefined);
    const job = { name: 'j', dueKey: everySeconds(60), run };
    const a = new Scheduler(store, logger(), [job]);
    const b = new Scheduler(store, logger(), [job]);
    const now = new Date('2026-10-06T10:00:30Z');
    await a.tick(now);
    await b.tick(now);
    await a.tick(new Date('2026-10-06T10:00:59Z'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a claim-store outage instead of crashing the process', async () => {
    vi.useFakeTimers();
    const log = logger();
    const store = { set: vi.fn(async () => Promise.reject(new Error('Redis stream not writeable'))), del: vi.fn(async () => 1) };
    const s = new Scheduler(store, log, [{ name: 'j', dueKey: () => 'k', run: async () => undefined }], 1000);
    s.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'Scheduler tick failed');
    await s.stop();
    vi.useRealTimers();
  });
});
