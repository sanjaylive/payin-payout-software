import { classify, isSafeToFailover, type ProviderError } from '../interfaces/errors';
import type { Candidate } from './engine';

export interface AttemptRecord {
  providerCode: string;
  ok: boolean;
  errorKind?: string;
  errorCode?: string;
  latencyMs: number;
}

export class FailoverStoppedError extends Error {
  constructor(
    readonly providerError: ProviderError,
    readonly attempts: AttemptRecord[],
    readonly candidate: Candidate,
  ) {
    super(`Stopped after an ambiguous outcome at ${candidate.providerCode}: ${providerError.message}`);
    this.name = 'FailoverStoppedError';
  }
}

export class NoProviderAvailableError extends Error {
  constructor(readonly attempts: AttemptRecord[]) {
    super(attempts.length ? 'All eligible providers refused or were unreachable' : 'No eligible provider for this transaction');
    this.name = 'NoProviderAvailableError';
  }
}

/**
 * Try candidates in order. Move to the next ONLY when the failure proves nothing happened at the
 * provider (NOT_ATTEMPTED / REJECTED / CONFIGURATION). An AMBIGUOUS outcome stops immediately —
 * the operation is left for status polling/reconciliation, never sent to a second provider.
 */
export async function executeWithFailover<T>(
  candidates: Candidate[],
  attempt: (candidate: Candidate, attemptNo: number) => Promise<T>,
  opts: { maxAttempts?: number; onAttempt?: (record: AttemptRecord, candidate: Candidate) => void | Promise<void> } = {},
): Promise<{ result: T; candidate: Candidate; attempts: AttemptRecord[] }> {
  const attempts: AttemptRecord[] = [];
  const max = Math.min(opts.maxAttempts ?? 3, candidates.length);
  for (let i = 0; i < max; i++) {
    const candidate = candidates[i]!;
    const started = Date.now();
    try {
      const result = await attempt(candidate, i + 1);
      const record = { providerCode: candidate.providerCode, ok: true, latencyMs: Date.now() - started };
      attempts.push(record);
      await opts.onAttempt?.(record, candidate);
      return { result, candidate, attempts };
    } catch (raw) {
      const err = classify(raw, candidate.providerCode);
      const record = { providerCode: candidate.providerCode, ok: false, errorKind: err.kind, errorCode: err.code, latencyMs: Date.now() - started };
      attempts.push(record);
      await opts.onAttempt?.(record, candidate);
      if (!isSafeToFailover(err)) throw new FailoverStoppedError(err, attempts, candidate);
    }
  }
  throw new NoProviderAvailableError(attempts);
}
