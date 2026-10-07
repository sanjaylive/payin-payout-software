'use client';

import { RoadmapPlaceholder } from '@/components/common/roadmap-placeholder';
import { MERCHANT_NAV, PARTNER_NAV, RESELLER_NAV } from '@/components/shell/nav-config';
import { useMe } from '@/lib/auth/use-me';

export default function PortalRoadmapPage() {
  const { data } = useMe();
  return <RoadmapPlaceholder nav={data?.organization.type === 'RESELLER' ? RESELLER_NAV : data?.organization.type === 'API_PARTNER' ? PARTNER_NAV : MERCHANT_NAV} />;
}
