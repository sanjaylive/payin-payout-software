/**
 * Provider error taxonomy — the basis for safe failover (docs/ARCHITECTURE.md §9).
 *
 *  NOT_ATTEMPTED  The request never reached the provider (connection refused, DNS, circuit open,
 *                 rate-limited before processing). Nothing happened → safe to try another provider.
 *  REJECTED       The provider definitively refused it before acceptance (validation, unsupported
 *                 bank, insufficient float). Nothing happened → safe to try another provider.
 *  CONFIGURATION  Credentials/auth/config problem on our side. Not processed → safe, but alert.
 *  AMBIGUOUS      The request may have been processed (timeout after send, 5xx, malformed
 *                 response). Outcome unknown → NEVER retry elsewhere; resolve via status polling
 *                 or reconciliation. Retrying here is how duplicate transfers happen.
 */
export type ProviderErrorKind = 'NOT_ATTEMPTED' | 'REJECTED' | 'CONFIGURATION' | 'AMBIGUOUS';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string,
    message: string,
    readonly providerCode?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function isSafeToFailover(err: unknown): boolean {
  return err instanceof ProviderError && err.kind !== 'AMBIGUOUS';
}

/** Anything that isn't a classified ProviderError is treated as AMBIGUOUS — the safe default. */
export function classify(err: unknown, providerCode?: string): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError('AMBIGUOUS', 'UNCLASSIFIED_ERROR', err instanceof Error ? err.message : 'Unknown provider error', providerCode);
}
