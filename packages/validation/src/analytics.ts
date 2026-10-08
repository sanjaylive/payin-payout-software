import { z } from 'zod';
import { idSchema } from './common';

const MAX_DAYS = 92;

/** Analytics over a time range (docs/ANALYTICS.md): at most 92 days. */
export const analyticsQuerySchema = z
  .strictObject({
    kind: z.enum(['payin', 'payout']).default('payin'),
    merchant_id: idSchema('org').optional(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .refine((q) => new Date(q.to) > new Date(q.from), { path: ['to'], message: 'Must be after from' })
  .refine((q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= MAX_DAYS * 86_400_000, { path: ['to'], message: `At most ${MAX_DAYS} days` });
