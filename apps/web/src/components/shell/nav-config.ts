import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpenText,
  Building2,
  ChartColumn,
  Code2,
  FileCheck2,
  FileClock,
  Gauge,
  Handshake,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Receipt,
  Scale,
  ServerCog,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Tags,
  Users,
  Webhook,
} from 'lucide-react';

/** Highest delivered phase — nav entries above it render roadmap placeholders. */
export const CURRENT_PHASE = 7;

export interface NavLeaf {
  label: string;
  href: string;
  /** Phase that delivers the module; pages from later phases render a roadmap placeholder. */
  phase: number;
  permission?: string;
}

export interface NavItem extends Partial<NavLeaf> {
  label: string;
  icon: LucideIcon;
  children?: NavLeaf[];
}

export const MERCHANT_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, phase: 1 },
  {
    label: 'Payin',
    icon: ArrowDownToLine,
    children: [
      { label: 'Transactions', href: '/payin/transactions', phase: 5, permission: 'payin.read' },
      { label: 'Create Payment', href: '/payin/create', phase: 5, permission: 'payin.create' },
      { label: 'QR Codes', href: '/payin/qr-codes', phase: 5, permission: 'payin.read' },
      { label: 'Payment Links', href: '/payin/payment-links', phase: 5, permission: 'payin.read' },
      { label: 'Refunds', href: '/payin/refunds', phase: 5, permission: 'payin.read' },
    ],
  },
  {
    label: 'Payout',
    icon: ArrowUpFromLine,
    children: [
      { label: 'Transactions', href: '/payout/transactions', phase: 6, permission: 'payout.read' },
      { label: 'Make Payout', href: '/payout/create', phase: 6, permission: 'payout.create' },
      { label: 'Bulk Payout', href: '/payout/bulk', phase: 6, permission: 'payout.create' },
      { label: 'Beneficiaries', href: '/payout/beneficiaries', phase: 6, permission: 'beneficiary.read' },
      { label: 'Approvals', href: '/payout/approvals', phase: 6, permission: 'payout.approve' },
    ],
  },
  { label: 'Settlements', href: '/settlements', icon: Landmark, phase: 8, permission: 'settlement.read' },
  {
    label: 'Accounts',
    icon: Scale,
    children: [
      { label: 'Balance', href: '/accounts/balance', phase: 3, permission: 'ledger.read' },
      { label: 'Ledger', href: '/accounts/ledger', phase: 3, permission: 'ledger.read' },
      { label: 'Fees & invoices', href: '/accounts/fees', phase: 8, permission: 'ledger.read' },
    ],
  },
  { label: 'Reports', href: '/reports', icon: ChartColumn, phase: 10, permission: 'report.read' },
  {
    label: 'Developers',
    icon: Code2,
    children: [
      { label: 'API Keys', href: '/developers/api-keys', phase: 9, permission: 'api_key.read' },
      { label: 'Documentation', href: '/developers/docs', phase: 9 },
      { label: 'Webhooks', href: '/developers/webhooks', phase: 7, permission: 'webhook.read' },
      { label: 'Webhook Logs', href: '/developers/webhook-logs', phase: 7, permission: 'webhook.read' },
      { label: 'IP Whitelist', href: '/developers/ip-whitelist', phase: 9, permission: 'api_key.read' },
      { label: 'API Logs', href: '/developers/api-logs', phase: 9, permission: 'api_key.read' },
    ],
  },
  {
    label: 'Compliance',
    icon: FileCheck2,
    children: [
      { label: 'Business Profile', href: '/compliance/profile', phase: 2 },
      { label: 'Documents', href: '/compliance/documents', phase: 2 },
      { label: 'Bank Account', href: '/compliance/bank-account', phase: 2 },
      { label: 'Agreement', href: '/compliance/agreement', phase: 2 },
    ],
  },
  { label: 'Team', href: '/team', icon: Users, phase: 1, permission: 'user.read' },
  { label: 'Settings', href: '/settings/security', icon: Settings, phase: 1 },
];

export const RESELLER_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/reseller', icon: LayoutDashboard, phase: 1 },
  { label: 'Merchants', href: '/reseller/merchants', icon: Building2, phase: 1, permission: 'merchant.read' },
  { label: 'Payin', href: '/reseller/payin', icon: ArrowDownToLine, phase: 5, permission: 'payin.read' },
  { label: 'Payout', href: '/reseller/payout', icon: ArrowUpFromLine, phase: 6, permission: 'payout.read' },
  { label: 'Pricing', href: '/reseller/pricing', icon: Tags, phase: 9, permission: 'pricing.read' },
  { label: 'Commissions', href: '/reseller/commissions', icon: Receipt, phase: 9 },
  { label: 'Earnings', href: '/reseller/earnings', icon: Landmark, phase: 9 },
  { label: 'Reports', href: '/reseller/reports', icon: ChartColumn, phase: 10, permission: 'report.read' },
  { label: 'Team', href: '/team', icon: Users, phase: 1, permission: 'user.read' },
  { label: 'Settings', href: '/settings/security', icon: Settings, phase: 1 },
];

export const ADMIN_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard, phase: 1 },
  {
    label: 'Merchants',
    icon: Building2,
    children: [
      { label: 'All Merchants', href: '/admin/merchants', phase: 1, permission: 'merchant.read' },
      { label: 'Pending KYC', href: '/admin/merchants/pending-kyc', phase: 2, permission: 'compliance.read' },
      { label: 'Sales Leads', href: '/admin/sales', phase: 2, permission: 'sales.read' },
      { label: 'Suspended', href: '/admin/merchants?status=SUSPENDED', phase: 1, permission: 'merchant.read' },
      { label: 'Limits', href: '/admin/merchants/limits', phase: 2, permission: 'limit.read' },
      { label: 'Pricing', href: '/admin/merchants/pricing', phase: 5, permission: 'pricing.read' },
    ],
  },
  { label: 'Resellers', href: '/admin/resellers', icon: Network, phase: 1, permission: 'reseller.read' },
  { label: 'API Partners', href: '/admin/api-partners', icon: Handshake, phase: 1, permission: 'api_partner.read' },
  {
    label: 'Transactions',
    icon: Receipt,
    children: [
      { label: 'Payin', href: '/admin/transactions/payin', phase: 5, permission: 'payin.read' },
      { label: 'Payout', href: '/admin/transactions/payout', phase: 6, permission: 'payout.read' },
      { label: 'Refunds', href: '/admin/transactions/refunds', phase: 5, permission: 'payin.read' },
    ],
  },
  { label: 'Settlements', href: '/admin/settlements', icon: Landmark, phase: 8, permission: 'settlement.read' },
  {
    label: 'Ledger',
    icon: Scale,
    children: [
      { label: 'Accounts', href: '/admin/ledger/accounts', phase: 3, permission: 'ledger.platform.read' },
      { label: 'Journals', href: '/admin/ledger/journals', phase: 3, permission: 'ledger.platform.read' },
      { label: 'Adjustments', href: '/admin/ledger/adjustments', phase: 3, permission: 'ledger.adjust.approve' },
    ],
  },
  {
    label: 'Providers',
    icon: ServerCog,
    children: [
      { label: 'Payin Providers', href: '/admin/providers/payin', phase: 4, permission: 'provider.read' },
      { label: 'Payout Providers', href: '/admin/providers/payout', phase: 4, permission: 'provider.read' },
      { label: 'Routes', href: '/admin/providers/routes', phase: 4, permission: 'provider.read' },
      { label: 'Health', href: '/admin/providers/health', phase: 4, permission: 'provider.read' },
    ],
  },
  { label: 'Pricing', href: '/admin/pricing', icon: Tags, phase: 5, permission: 'pricing.read' },
  {
    label: 'Risk',
    icon: ShieldAlert,
    children: [
      { label: 'Rules', href: '/admin/risk/rules', phase: 10, permission: 'risk.read' },
      { label: 'Events', href: '/admin/risk/events', phase: 10, permission: 'risk.read' },
      { label: 'Manual Reviews', href: '/admin/risk/reviews', phase: 10, permission: 'risk.review' },
    ],
  },
  { label: 'Compliance', href: '/admin/compliance', icon: FileCheck2, phase: 2, permission: 'compliance.read' },
  { label: 'Reconciliation', href: '/admin/reconciliation', icon: Gauge, phase: 8, permission: 'reconciliation.read' },
  { label: 'Webhooks', href: '/admin/webhooks', icon: Webhook, phase: 7, permission: 'webhook.read' },
  { label: 'Reports', href: '/admin/reports', icon: ChartColumn, phase: 10, permission: 'report.read' },
  { label: 'Users & Roles', href: '/admin/users', icon: ShieldCheck, phase: 1, permission: 'user.read' },
  { label: 'Audit Logs', href: '/admin/audit-logs', icon: FileClock, phase: 1, permission: 'audit.read' },
  { label: 'System Settings', href: '/admin/settings', icon: BookOpenText, phase: 10, permission: 'system.settings.manage' },
];

/** Find the nav leaf for a path (used by roadmap placeholder pages). */
export function findNavLeaf(nav: NavItem[], pathname: string): NavLeaf | undefined {
  for (const item of nav) {
    if (item.href && item.phase !== undefined && item.href.split('?')[0] === pathname) {
      return { label: item.label, href: item.href, phase: item.phase, permission: item.permission };
    }
    const child = item.children?.find((c) => c.href.split('?')[0] === pathname);
    if (child) return child;
  }
  return undefined;
}
