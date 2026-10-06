import { Injectable, type NestMiddleware } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextStore } from './request-context';

/** Accept an upstream request id only if it looks safe; otherwise generate our own. */
const INBOUND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

export function resolveRequestId(req: Request): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  return typeof inbound === 'string' && INBOUND_REQUEST_ID.test(inbound) ? inbound : newId('request');
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // pino-http assigns req.id first (see logger config) so both share the same value.
    const requestId = typeof req.id === 'string' ? req.id : resolveRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    const ua = req.headers['user-agent'];
    RequestContextStore.run(
      {
        requestId,
        ipAddress: req.ip ?? null,
        userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
      },
      next,
    );
  }
}
