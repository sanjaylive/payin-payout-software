import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';

export const organizationTypeSchema = z.enum(['PLATFORM', 'RESELLER', 'API_PARTNER', 'MERCHANT']);
export const organizationStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']);

export const createOrganizationSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['RESELLER', 'API_PARTNER', 'MERCHANT']),
  /** Parent reseller for merchants onboarded through a reseller. Authorized against scope server-side. */
  parent_id: idSchema('org').optional(),
});
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const listOrganizationsQuerySchema = paginationQuerySchema.extend({
  type: organizationTypeSchema.optional(),
  status: organizationStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
});

export const updateOrganizationStatusSchema = z.strictObject({
  status: organizationStatusSchema,
  reason: z.string().trim().min(5).max(500),
});

export const createUserSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  mobile: mobileSchema.optional(),
  role_key: z.string().regex(/^[A-Z_]{3,40}$/),
  /** Organization to add the user to. Defaults to the actor's active organization. */
  organization_id: idSchema('org').optional(),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  organization_id: idSchema('org').optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional(),
  search: z.string().trim().max(100).optional(),
});

export const updateUserStatusSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'DISABLED']),
  reason: z.string().trim().min(5).max(500),
});

export const assignRoleSchema = z.strictObject({
  role_key: z.string().regex(/^[A-Z_]{3,40}$/),
  organization_id: idSchema('org').optional(),
});

export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  organization_id: idSchema('org').optional(),
  actor_id: idSchema('usr').optional(),
  action: z.string().trim().max(100).optional(),
  resource_type: z.string().trim().max(50).optional(),
  resource_id: z.string().trim().max(60).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
