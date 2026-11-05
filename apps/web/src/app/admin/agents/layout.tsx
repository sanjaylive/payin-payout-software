'use client';

import { cn } from '@pay2all/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/common/page-header';

const TABS = [
  { label: 'Agents', href: '/admin/agents' },
  { label: 'Plans', href: '/admin/agents/plans' },
  { label: 'Settings', href: '/admin/agents/settings' },
];

/** Admin → Agents (customer service points, docs/AGENTS.md). Tabs are routes. */
export default function AdminAgentsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const detail = !TABS.some((t) => t.href === pathname);
  if (detail) return <>{children}</>;
  return (
    <>
      <PageHeader title="Agents" description="Customer service points: their plans, usage and plan billing. Agent records never move money." />
      <nav aria-label="Agents sections" className="-mx-1 mb-6 overflow-x-auto border-b">
        <div className="flex min-w-max gap-1 px-1">
          {TABS.map((t) => {
            const active = pathname === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                  active ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
      {children}
    </>
  );
}
