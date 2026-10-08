import { type OrgScope, type PermissionKey, permissionsForScope } from './permissions';

export interface SystemRoleDefinition {
  key: string;
  name: string;
  scope: OrgScope;
  requiresMfa: boolean;
  description: string;
  permissions: readonly PermissionKey[];
}

const platformAll = permissionsForScope('PLATFORM');
const merchantAll = permissionsForScope('MERCHANT');

const without = (list: readonly PermissionKey[], ...remove: PermissionKey[]) =>
  list.filter((p) => !remove.includes(p));

/**
 * System roles seeded into every environment. Business code must check permissions,
 * never these role keys (docs/SECURITY.md §2.2).
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  // ---- Platform staff (Pay2All) -------------------------------------------------------------
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Full platform access including system settings and role management',
    permissions: platformAll,
  },
  {
    key: 'ADMIN',
    name: 'Admin',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Platform administration without system settings or role editing',
    permissions: without(platformAll, 'system.settings.manage', 'role.manage'),
  },
  {
    key: 'COMPLIANCE',
    name: 'Compliance',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'KYC/KYB review, merchant approval and risk review',
    permissions: [
      'organization.read', 'user.read', 'audit.read', 'merchant.read', 'merchant.approve',
      'merchant.suspend', 'compliance.read', 'compliance.approve', 'risk.read', 'risk.review', 'risk.manage', 'dispute.read', 'dispute.manage',
      'payin.read', 'payout.read', 'settlement.read', 'settlement.hold', 'limit.read', 'report.read',
    ],
  },
  {
    key: 'FINANCE',
    name: 'Finance',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Ledger, settlements, reconciliation and adjustments',
    permissions: [
      'organization.read', 'audit.read', 'merchant.read', 'payin.read', 'payout.read', 'dispute.read',
      'ledger.read', 'ledger.platform.read', 'ledger.adjust', 'ledger.adjust.approve', 'settlement.read', 'fund.read', 'fund.approve',
      'settlement.process', 'settlement.hold', 'reconciliation.read', 'reconciliation.manage',
      'pricing.read', 'provider.read', 'report.read', 'report.export',
    ],
  },
  {
    key: 'OPERATIONS',
    name: 'Operations',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Transaction operations, providers, routing and limits',
    permissions: [
      'organization.read', 'merchant.read', 'merchant.update', 'payin.read', 'payin.refund', 'dispute.read', 'dispute.manage',
      'payout.read', 'payout.review', 'beneficiary.read', 'provider.read', 'provider.manage',
      'routing.manage', 'webhook.read', 'webhook.manage', 'limit.read', 'limit.manage',
      'risk.read', 'risk.review', 'reconciliation.read', 'settlement.read', 'ledger.read', 'ledger.platform.read',
      'report.read', 'report.export', 'fund.read',
    ],
  },
  {
    key: 'SUPPORT',
    name: 'Support',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Read-only investigation of merchants and transactions',
    permissions: [
      'organization.read', 'user.read', 'merchant.read', 'payin.read', 'payout.read', 'dispute.read',
      'webhook.read', 'settlement.read', 'report.read', 'fund.read',
    ],
  },
  {
    key: 'SALES',
    name: 'Sales',
    scope: 'PLATFORM',
    requiresMfa: true,
    description: 'Merchant acquisition and lead management',
    permissions: [
      'organization.read', 'merchant.read', 'merchant.create', 'merchant.update', 'sales.read',
      'sales.manage', 'reseller.read', 'pricing.read', 'user.read',
    ],
  },

  // ---- Reseller / API partner -----------------------------------------------------------------
  {
    key: 'RESELLER',
    name: 'Reseller Admin',
    scope: 'RESELLER',
    requiresMfa: true,
    description: 'Manages the reseller organization and its merchants',
    permissions: [
      'organization.read', 'user.read', 'user.manage', 'role.read', 'audit.read', 'merchant.read',
      'merchant.create', 'merchant.update', 'compliance.read', 'payin.read', 'payout.read',
      'ledger.read', 'settlement.read', 'pricing.read', 'pricing.manage', 'limit.read',
      'limit.manage', 'approval_policy.manage', 'reseller.read', 'webhook.read', 'api_key.read',
      'report.read', 'report.export',
    ],
  },
  {
    key: 'API_PARTNER',
    name: 'API Partner Admin',
    scope: 'API_PARTNER',
    requiresMfa: true,
    description: 'Manages API partner integration, credentials and mapped merchants',
    permissions: [
      'organization.read', 'user.read', 'user.manage', 'role.read', 'audit.read', 'merchant.read', 'merchant.create',
      'payin.read', 'payin.create', 'payin.refund', 'payout.read', 'payout.create',
      'payout.approve', 'beneficiary.read', 'beneficiary.manage', 'ledger.read', 'settlement.read',
      'pricing.read', 'limit.read', 'approval_policy.manage', 'webhook.read', 'webhook.manage',
      'api_key.read', 'api_key.manage', 'api_partner.read', 'report.read', 'report.export',
    ],
  },

  // ---- Merchant team --------------------------------------------------------------------------
  {
    key: 'MERCHANT_OWNER',
    name: 'Owner',
    scope: 'MERCHANT',
    requiresMfa: true,
    description: 'Full access to the merchant account',
    permissions: merchantAll,
  },
  {
    key: 'MERCHANT_ADMIN',
    name: 'Admin',
    scope: 'MERCHANT',
    requiresMfa: true,
    description: 'Full access except actions reserved for owners by policy',
    permissions: merchantAll,
  },
  {
    key: 'MERCHANT_DEVELOPER',
    name: 'Developer',
    scope: 'MERCHANT',
    requiresMfa: false,
    description: 'API keys, webhooks and integration logs',
    permissions: [
      'organization.read', 'payin.read', 'payout.read', 'webhook.read', 'webhook.manage',
      'api_key.read', 'api_key.manage', 'report.read',
    ],
  },
  {
    key: 'MERCHANT_FINANCE',
    name: 'Finance',
    scope: 'MERCHANT',
    requiresMfa: false,
    description: 'Payouts, approvals, balances and settlements',
    permissions: [
      'organization.read', 'payin.read', 'payin.refund', 'dispute.read', 'dispute.respond', 'payout.read', 'payout.create',
      'payout.approve', 'beneficiary.read', 'beneficiary.manage', 'ledger.read',
      'settlement.read', 'limit.read', 'report.read', 'report.export', 'fund.read', 'fund.request',
    ],
  },
  {
    key: 'MERCHANT_OPERATIONS',
    name: 'Operations',
    scope: 'MERCHANT',
    requiresMfa: false,
    description: 'Day-to-day payments, payouts and refunds',
    permissions: [
      'organization.read', 'payin.read', 'payin.create', 'payin.refund', 'dispute.read', 'dispute.respond', 'payout.read',
      'payout.create', 'beneficiary.read', 'beneficiary.manage', 'settlement.read', 'report.read',
    ],
  },
  {
    key: 'MERCHANT_VIEWER',
    name: 'Viewer',
    scope: 'MERCHANT',
    requiresMfa: false,
    description: 'Read-only access',
    permissions: [
      'organization.read', 'merchant.read', 'payin.read', 'dispute.read', 'payout.read', 'settlement.read',
      'ledger.read', 'report.read',
    ],
  },
];

export function getSystemRole(key: string): SystemRoleDefinition | undefined {
  return SYSTEM_ROLES.find((r) => r.key === key);
}
