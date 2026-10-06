import { ApiError } from './client';

export function toTableError(err: unknown): { message: string; requestId?: string } | null {
  if (!err) return null;
  return err instanceof ApiError ? { message: err.message, requestId: err.requestId } : { message: 'Unexpected error' };
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}
