import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';

export const LOGIN_OUTCOMES = ['SUCCESS', 'MFA_REQUIRED', 'MFA_FAILED', 'BAD_PASSWORD', 'LOCKED', 'DISABLED', 'NOT_ACTIVATED', 'NO_ACTIVE_ORGANIZATION', 'UNKNOWN_USER'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const listLoginEventsQuerySchema = paginationQuerySchema.extend({
  /** Platform / reseller: whose sign-ins. Merchants always see their own organization. */
  organization_id: idSchema('org').optional(),
  user_id: idSchema('usr').optional(),
  outcome: z.enum(LOGIN_OUTCOMES).optional(),
  /** Successful sign-ins only, or failures only. */
  result: z.enum(['success', 'failure']).optional(),
  from: day.optional(),
  to: day.optional(),
});

export const loginEventsExportSchema = z
  .strictObject({
    organization_id: idSchema('org').optional(),
    from: day,
    to: day,
  })
  .refine((r) => r.from <= r.to, { message: '`from` must not be after `to`', path: ['to'] })
  .refine((r) => (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 < 92, { message: 'At most 92 days', path: ['to'] });
