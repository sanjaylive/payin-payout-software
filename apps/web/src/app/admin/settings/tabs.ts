/** Settings tabs, in display order. Each is its own route, so links, bookmarks and Back work. */
export const SETTINGS_TABS: { label: string; href: string; permission?: string }[] = [
  { label: 'System', href: '/admin/settings/system', permission: 'system.settings.manage' },
  { label: 'File Storage', href: '/admin/settings/storage', permission: 'system.settings.manage' },
  { label: 'Pricing Providers', href: '/admin/settings/pricing-providers', permission: 'pricing.read' },
  { label: 'API Vendors', href: '/admin/settings/vendors', permission: 'provider.read' },
  { label: 'Routing', href: '/admin/settings/routing', permission: 'provider.read' },
  { label: 'Vendor Health', href: '/admin/settings/vendor-health', permission: 'provider.read' },
  { label: 'My Security', href: '/admin/settings/security' },
];
