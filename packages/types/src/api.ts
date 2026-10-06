import type { ErrorCode } from './errors';

export interface PaginationMeta {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface ApiSuccess<T, M = Record<string, unknown>> {
  success: true;
  data: T;
  meta?: M;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  request_id: string;
  /** Field-level validation issues (INVALID_REQUEST only). */
  details?: { path: string; message: string }[];
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T, M = Record<string, unknown>> = ApiSuccess<T, M> | ApiFailure;
