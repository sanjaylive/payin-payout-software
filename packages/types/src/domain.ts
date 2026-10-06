/** Organization (tenant) types. Mirrors the Prisma enum; shared with the web app. */
export const OrganizationType = {
  PLATFORM: 'PLATFORM',
  RESELLER: 'RESELLER',
  API_PARTNER: 'API_PARTNER',
  MERCHANT: 'MERCHANT',
} as const;
export type OrganizationType = (typeof OrganizationType)[keyof typeof OrganizationType];

export const OrganizationStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

export const UserStatus = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
