import type { Bucket } from './types';

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

/** Same idempotency key, different lines: a programming error, never a retry. */
export class LedgerIdempotencyConflict extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different journal`);
    this.name = 'LedgerIdempotencyConflict';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    readonly accountCode: string,
    readonly bucket: Bucket | null,
    readonly availableMinor: bigint,
    readonly requiredMinor: bigint,
  ) {
    super(`Insufficient balance in ${accountCode}`);
    this.name = 'InsufficientBalanceError';
  }
}

export class JournalAlreadyReversedError extends Error {
  constructor(readonly journalId: string) {
    super(`Journal ${journalId} has already been reversed`);
    this.name = 'JournalAlreadyReversedError';
  }
}
