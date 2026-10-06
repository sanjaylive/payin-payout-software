'use client';

import { EmptyState } from '@pay2all/ui/components/states';
import { Construction } from 'lucide-react';
import { notFound, usePathname } from 'next/navigation';
import { findNavLeaf, type NavItem } from '../shell/nav-config';
import { PageHeader } from './page-header';

const PHASE_NAMES: Record<number, string> = {
  2: 'Merchant & Compliance',
  3: 'Ledger',
  4: 'Provider architecture',
  5: 'Payin',
  6: 'Payout',
  7: 'Kafka, workers & webhooks',
  8: 'Settlement & reconciliation',
  9: 'Reseller & API partner',
  10: 'Risk, monitoring & hardening',
};

/** Honest placeholder for navigation entries delivered in later phases (docs/ROADMAP.md). */
export function RoadmapPlaceholder({ nav }: { nav: NavItem[] }) {
  const pathname = usePathname();
  const leaf = findNavLeaf(nav, pathname);
  if (!leaf) notFound();
  return (
    <>
      <PageHeader title={leaf.label} />
      <div className="bg-card rounded-lg border">
        <EmptyState
          icon={Construction}
          title={`Arrives in Phase ${leaf.phase}: ${PHASE_NAMES[leaf.phase] ?? ''}`}
          description="This module is part of the Pay2All implementation roadmap. Its backend APIs are built and verified before the screen is enabled."
        />
      </div>
    </>
  );
}
