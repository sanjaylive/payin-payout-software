import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { ApiSuccess } from '@pay2all/types';
import { map, type Observable } from 'rxjs';
import { Paginated } from './paginated';

/** Wraps every successful response as { success: true, data, meta? }. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiSuccess<unknown>> {
    return next.handle().pipe(
      map((result: unknown) => {
        if (result instanceof Paginated) {
          return { success: true as const, data: result.items, meta: { ...result.meta } };
        }
        return { success: true as const, data: result ?? null };
      }),
    );
  }
}
