import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';

export const leadStatusSchema = z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST']);

export const createLeadSchema = z.strictObject({
  company_name: z.string().trim().min(2).max(160),
  contact_name: z.string().trim().min(2).max(120),
  contact_email: emailSchema.optional(),
  contact_mobile: mobileSchema.optional(),
  source: z.string().trim().min(2).max(80),
  expected_monthly_volume: z.string().trim().max(40).optional(),
  follow_up_date: z.iso.date().optional(),
  notes: z.string().trim().max(4000).optional(),
  assigned_sales_user_id: idSchema('usr').optional(),
});

export const updateLeadSchema = z.strictObject({
  status: leadStatusSchema.exclude(['CONVERTED']).optional(),
  follow_up_date: z.iso.date().nullable().optional(),
  assigned_sales_user_id: idSchema('usr').nullable().optional(),
  /** Appended to the lead's notes log with author and timestamp. */
  note: z.string().trim().min(2).max(2000).optional(),
});

export const listLeadsQuerySchema = paginationQuerySchema.extend({
  status: leadStatusSchema.optional(),
  assigned_to: z.union([idSchema('usr'), z.literal('me')]).optional(),
  search: z.string().trim().max(100).optional(),
});

export const convertLeadSchema = z.strictObject({ reseller_id: idSchema('org').optional() });

export const salesAssignmentSchema = z.strictObject({ assigned_sales_user_id: idSchema('usr').nullable() });
