import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@pay2all/database';
import { type ApiFailure, ErrorCode } from '@pay2all/types';
import type { Response } from 'express';
import { RequestContextStore } from '../context/request-context';
import { ReplayedResponse } from '../idempotency/idempotency.service';
import { AppError } from './app-error';

const HTTP_STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.INVALID_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.INVALID_REQUEST,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

/**
 * Normalizes every error into { success: false, error: { code, message, request_id } }.
 * Unknown errors never leak internals to clients; details go to logs (and Sentry when configured).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ReplayedResponse) {
      // Idempotent replay: the original response, byte-for-byte.
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(exception.status).json(exception.body);
      return;
    }
    const requestId = RequestContextStore.get()?.requestId ?? 'unknown';
    const appError = this.toAppError(exception);

    if (appError.status >= 500) {
      this.logger.error({ err: exception, requestId }, 'Unhandled error');
    }

    const body: ApiFailure = {
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
        request_id: requestId,
        ...(appError.details?.length ? { details: appError.details } : {}),
      },
    };
    if (appError.headers) {
      for (const [k, v] of Object.entries(appError.headers)) res.setHeader(k, v);
    }
    res.status(appError.status).json(body);
  }

  private toAppError(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') return new AppError(ErrorCode.CONFLICT, 'Resource already exists');
      if (exception.code === 'P2025') return new AppError(ErrorCode.NOT_FOUND);
      return new AppError(ErrorCode.INTERNAL_ERROR);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_STATUS_TO_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_REQUEST);
      // Only surface framework messages for client errors (e.g. "Cannot GET /x"); never for 5xx.
      return new AppError(code, status < 500 ? exception.message : undefined);
    }

    // body-parser errors (malformed JSON, payload too large) carry a numeric status.
    if (exception instanceof Error && 'status' in exception && typeof exception.status === 'number') {
      const status = exception.status;
      if (status === 413) return new AppError(ErrorCode.INVALID_REQUEST, 'Request body too large');
      if (status >= 400 && status < 500) return new AppError(ErrorCode.INVALID_REQUEST, 'Malformed request body');
    }

    return new AppError(ErrorCode.INTERNAL_ERROR);
  }
}
