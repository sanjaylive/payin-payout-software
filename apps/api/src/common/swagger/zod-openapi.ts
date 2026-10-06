import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function toSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

/** Documents a request body from the same Zod schema used for validation (one source of truth). */
export function ApiZodBody(schema: z.ZodType, description?: string) {
  return ApiBody({ schema: toSchema(schema), ...(description ? { description } : {}) });
}

/** Documents query parameters from a Zod object schema. */
export function ApiZodQuery(schema: z.ZodObject) {
  const json = toSchema(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, prop]) =>
      ApiQuery({ name, required: required.has(name), schema: prop }),
    ),
  );
}
