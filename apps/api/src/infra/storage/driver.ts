import type { Readable } from 'node:stream';

/** One line of a connection test, shown in Settings → File Storage. */
export interface StorageCheck {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

/**
 * A place files can live (docs/FILE_STORAGE.md). Drivers only ever see ciphertext: StorageService
 * encrypts before put() and decrypts after get(). Names are opaque (`2026/10/<uuid>.bin`).
 */
export interface StorageDriver {
  /** Store the bytes under a new opaque name; returns the locator to read them back with. */
  put(name: string, body: Readable): Promise<string>;
  get(locator: string): Promise<Readable>;
  /** Idempotent: a missing object is not an error. */
  delete(locator: string): Promise<void>;
  /** Backend-specific checks before the read/write round trip (bucket reachable, folder shared…). */
  precheck(): Promise<StorageCheck[]>;
}

/** A failure with a message an administrator can act on (no secrets, no stack). */
export class StorageDriverError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StorageDriverError';
  }
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
}
