import { ErrorCode } from '@pay2all/types';
import { InsufficientBalanceError, JournalAlreadyReversedError, LedgerIdempotencyConflict, LedgerValidationError } from '@pay2all/ledger/engine';
import { AppError } from '../../common/errors/app-error';

const BUCKET_COPY: Record<string, string> = {
  AVAILABLE: 'available',
  UNSETTLED: 'unsettled',
  RESERVED: 'reserved',
  LIEN: 'lien',
  PENDING: 'pending',
};

/** Translate ledger domain errors into public API errors (never leaking balances of other accounts). */
export function mapLedgerError(err: unknown): unknown {
  if (err instanceof InsufficientBalanceError) {
    return new AppError(ErrorCode.INSUFFICIENT_BALANCE, `Insufficient ${BUCKET_COPY[err.bucket ?? ''] ?? ''} balance`.replace('  ', ' '));
  }
  if (err instanceof LedgerIdempotencyConflict) return new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, err.message);
  if (err instanceof JournalAlreadyReversedError) return new AppError(ErrorCode.CONFLICT, err.message);
  if (err instanceof LedgerValidationError) return new AppError(ErrorCode.INVALID_REQUEST, err.message);
  // Backstop: the CHECK (balance >= 0) constraint fired — treat exactly like the app-level check.
  if (err instanceof Error && /ledger_accounts_non_negative/.test(err.message)) return new AppError(ErrorCode.INSUFFICIENT_BALANCE);
  return err;
}
