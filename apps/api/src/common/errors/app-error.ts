import { ERROR_HTTP_STATUS, ERROR_MESSAGES, type ErrorCode } from '@pay2all/types';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The only error type business code should throw. Carries a stable public error code; the HTTP status
 * is derived from the code so the mapping can't drift between endpoints.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: ErrorDetail[],
    /** Extra response headers (e.g. Retry-After). */
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? ERROR_MESSAGES[code] ?? code);
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}
