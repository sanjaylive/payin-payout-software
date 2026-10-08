/**
 * Permission catalog — the single source of truth for authorization.
 *
 * `scopes` lists the organization types in which a permission may be granted. This is a hard
 * boundary: a custom MERCHANT role can never receive a PLATFORM-only permission such as
 * `merchant.approve`, regardless of what an admin UI sends.
 *
 * A permission answers "may the actor perform this action". *Which records* the action applies
 * to is decided separately by tenant scope (see docs/SECURITY.md §3).
 */
export type OrgScope = 'PLATFORM' | 'RESELLER' | 'API_PARTNER' | 'MERCHANT';

export interface PermissionDefinition {
  description: string;
  scopes: readonly OrgScope[];
}

const ALL: readonly OrgScope[] = ['PLATFORM', 'RESELLER', 'API_PARTNER', 'MERCHANT'];
const P: readonly OrgScope[] = ['PLATFORM'];

export const PERMISSIONS = {
  'organization.read': { description: 'View organization details', scopes: ALL },
  'organization.manage': { description: 'Create, update and suspend organizations', scopes: P },

  'user.read': { description: 'View users in scope', scopes: ALL },
  'user.manage': { description: 'Invite users, change roles, disable users', scopes: ALL },
  'role.read': { description: 'View roles and permissions', scopes: ALL },
  'role.manage': { description: 'Create and edit custom roles', scopes: P },
  'audit.read': { description: 'View audit logs in scope', scopes: ALL },

  'merchant.read': { description: 'View merchants and business profiles', scopes: ALL },
  'merchant.create': { description: 'Create merchants', scopes: ['PLATFORM', 'RESELLER', 'API_PARTNER'] },
  'merchant.update': { description: 'Update merchant profile', scopes: ['PLATFORM', 'RESELLER', 'MERCHANT'] },
  'merchant.approve': { description: 'Approve or reject merchant onboarding', scopes: P },
  'merchant.suspend': { description: 'Suspend or reactivate merchants', scopes: P },

  'compliance.read': { description: 'View KYC/KYB data and documents', scopes: ['PLATFORM', 'RESELLER', 'MERCHANT'] },
  'compliance.approve': { description: 'Verify documents and approve KYC', scopes: P },

  'payin.read': { description: 'View payin transactions', scopes: ALL },
  'payin.create': { description: 'Create payments and payment links', scopes: ['API_PARTNER', 'MERCHANT'] },
  'payin.refund': { description: 'Initiate refunds', scopes: ['PLATFORM', 'API_PARTNER', 'MERCHANT'] },
  'dispute.read': { description: 'View disputes and chargebacks', scopes: ['PLATFORM', 'MERCHANT'] },
  'dispute.respond': { description: 'Upload evidence for, or accept, disputes', scopes: ['MERCHANT'] },
  'dispute.manage': { description: 'Open and decide disputes (freezes and debits merchant funds)', scopes: P },

  'payout.read': { description: 'View payouts', scopes: ALL },
  'payout.create': { description: 'Create payouts', scopes: ['API_PARTNER', 'MERCHANT'] },
  'payout.approve': { description: 'Approve payouts (checker)', scopes: ['API_PARTNER', 'MERCHANT'] },
  'payout.review': { description: 'Resolve payouts in manual review', scopes: P },

  'beneficiary.read': { description: 'View beneficiaries', scopes: ['PLATFORM', 'API_PARTNER', 'MERCHANT'] },
  'beneficiary.manage': { description: 'Create and block beneficiaries', scopes: ['API_PARTNER', 'MERCHANT'] },

  'ledger.read': { description: 'View balances, ledger accounts and journals', scopes: ALL },
  'ledger.platform.read': { description: 'View platform-wide ledger totals, accounts and integrity checks', scopes: P },
  'ledger.adjust': { description: 'Create manual adjustment requests (maker)', scopes: P },
  'ledger.adjust.approve': { description: 'Approve manual adjustments (checker)', scopes: P },

  'fund.read': { description: 'View wallet fund requests', scopes: ['PLATFORM', 'MERCHANT'] },
  'fund.request': { description: 'Request a wallet top-up (pay, then submit the UTR)', scopes: ['MERCHANT'] },
  'fund.approve': { description: 'Approve or reject wallet fund requests', scopes: P },

  'settlement.read': { description: 'View settlements', scopes: ALL },
  'settlement.process': { description: 'Generate and process settlements', scopes: P },
  'settlement.hold': { description: 'Place and release settlement holds', scopes: P },

  'provider.read': { description: 'View providers and health', scopes: P },
  'provider.manage': { description: 'Configure providers and credentials', scopes: P },
  'routing.manage': { description: 'Configure provider routing rules', scopes: P },

  'pricing.read': { description: 'View pricing plans', scopes: ['PLATFORM', 'RESELLER', 'API_PARTNER'] },
  'pricing.manage': { description: 'Create and assign pricing plans', scopes: ['PLATFORM', 'RESELLER'] },

  'limit.read': { description: 'View transaction limits', scopes: ALL },
  'limit.manage': { description: 'Change transaction limits', scopes: ['PLATFORM', 'RESELLER'] },
  'approval_policy.manage': {
    description: 'Configure payout maker-checker approval tiers',
    scopes: ['PLATFORM', 'RESELLER', 'API_PARTNER', 'MERCHANT'],
  },

  'risk.read': { description: 'View risk rules and events', scopes: P },
  'risk.manage': { description: 'Configure risk rules', scopes: P },
  'risk.review': { description: 'Resolve risk manual reviews', scopes: P },

  'reconciliation.read': { description: 'View reconciliation runs', scopes: P },
  'reconciliation.manage': { description: 'Import files and resolve mismatches', scopes: P },

  'merchant.integration.manage': { description: "Manage a merchant's webhook endpoints and IP allowlist on its behalf", scopes: P },
  'webhook.read': { description: 'View webhook endpoints and delivery logs', scopes: ALL },
  'webhook.manage': { description: 'Configure webhook endpoints and replay deliveries', scopes: ['PLATFORM', 'API_PARTNER', 'MERCHANT'] },

  'api_key.read': { description: 'View API keys (never secrets)', scopes: ['RESELLER', 'API_PARTNER', 'MERCHANT'] },
  'api_key.manage': { description: 'Create, rotate and revoke API keys and IP allowlists', scopes: ['API_PARTNER', 'MERCHANT'] },

  'reseller.read': { description: 'View resellers', scopes: ['PLATFORM', 'RESELLER'] },
  'reseller.manage': { description: 'Create and manage resellers', scopes: P },
  'api_partner.read': { description: 'View API partners', scopes: ['PLATFORM', 'API_PARTNER'] },
  'api_partner.manage': { description: 'Create and manage API partners', scopes: P },

  'sales.read': { description: 'View sales leads', scopes: P },
  'sales.manage': { description: 'Manage sales leads and assignments', scopes: P },

  'report.read': { description: 'View reports', scopes: ALL },
  'report.export': { description: 'Export reports', scopes: ALL },

  'system.settings.manage': { description: 'Change platform-wide settings', scopes: P },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function permissionsForScope(scope: OrgScope): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => (PERMISSIONS[k].scopes as readonly OrgScope[]).includes(scope));
}
