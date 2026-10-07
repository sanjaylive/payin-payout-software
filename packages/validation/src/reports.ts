import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';

export const REPORT_TYPES = ['PAYMENTS', 'REFUNDS', 'PAYOUTS', 'SETTLEMENTS', 'LOGIN_EVENTS'] as const;
export type ReportTypeValue = (typeof REPORT_TYPES)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** A single export covers at most this many days (larger ranges: several exports). */
export const REPORT_MAX_RANGE_DAYS = 92;

/** Async export request (docs/REPORTS.md). Dates are IST calendar days, inclusive. */
export const createReportExportSchema = z
  .strictObject({
    type: z.enum(REPORT_TYPES),
    /** XLSX is reserved for a later writer; only CSV is generated today. */
    format: z.literal('CSV').default('CSV'),
    from: day,
    to: day,
    status: z.string().trim().regex(/^[A-Z_]{2,30}$/).optional(),
    /** Platform / reseller scope only: narrow to one merchant (checked against the caller's scope). */
    merchant_id: idSchema('org').optional(),
    /** Email the requester a sign-in-protected download link when the file is ready. */
    notify_by_email: z.boolean().default(false),
  })
  .refine((r) => r.from <= r.to, { message: '`from` must not be after `to`', path: ['to'] })
  .refine((r) => (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 < REPORT_MAX_RANGE_DAYS, {
    message: `A report can cover at most ${REPORT_MAX_RANGE_DAYS} days`,
    path: ['to'],
  });

export const listReportExportsQuerySchema = paginationQuerySchema;

export const reportExportIdSchema = idSchema('rpt');
