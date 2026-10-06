import { type PipeTransform } from '@nestjs/common';
import { ErrorCode } from '@pay2all/types';
import type { z } from 'zod';
import { AppError } from '../errors/app-error';

/**
 * Validates and transforms input with a Zod schema. Use per-parameter:
 *   @Body(new ZodValidationPipe(loginSchema)) body: z.output<typeof loginSchema>
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new AppError(
      ErrorCode.INVALID_REQUEST,
      'Request validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
}
