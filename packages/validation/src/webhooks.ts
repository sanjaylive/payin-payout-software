import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';

/** Merchant-facing event types (docs/WEBHOOKS.md). */
export const MERCHANT_EVENT_TYPES = [
  'payment.created',
  'payment.pending',
  'payment.success',
  'payment.failed',
  'refund.created',
  'refund.success',
  'refund.failed',
  'payout.created',
  'payout.queued',
  'payout.processing',
  'payout.success',
  'payout.failed',
  'payout.rejected',
  'payout.reversed',
] as const;
export type MerchantEventTypeValue = (typeof MERCHANT_EVENT_TYPES)[number];

const url = z
  .string()
  .trim()
  .max(500)
  .url('Enter a full URL, e.g. https://example.com/webhooks/pay2all')
  .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed')
  .refine((u) => !/@/.test(new URL(u).host) && !new URL(u).username, 'Credentials in the URL are not allowed');

export const createWebhookEndpointSchema = z.strictObject({
  url,
  description: z.string().trim().max(200).optional(),
  /** Empty or omitted = all events. */
  events: z.array(z.enum(MERCHANT_EVENT_TYPES)).max(MERCHANT_EVENT_TYPES.length).default([]),
});

export const updateWebhookEndpointSchema = z
  .strictObject({
    url: url.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    events: z.array(z.enum(MERCHANT_EVENT_TYPES)).max(MERCHANT_EVENT_TYPES.length).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const listWebhookEventsQuerySchema = paginationQuerySchema.extend({
  type: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
  resource_id: z.string().regex(/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  merchant_id: idSchema('org').optional(),
});

export const listWebhookDeliveriesQuerySchema = paginationQuerySchema.extend({
  endpoint_id: idSchema('whe').optional(),
  event_id: idSchema('evt').optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
  merchant_id: idSchema('org').optional(),
});
