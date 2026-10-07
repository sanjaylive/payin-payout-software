'use client';

import { cn } from '@pay2all/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { useCan } from '@/lib/auth/use-me';
import { SETTINGS_TABS } from './tabs';

/** One Settings page; its sections are tabs (route links) instead of sidebar sub-items. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const can = useCan();
  const tabs = SETTINGS_TABS.filter((t) => !t.permission || can(t.permission));
  return (
    <>
      <PageHeader title="Settings" description="Platform configuration, API vendors and your own sign-in security." />
      <nav aria-label="Settings sections" className="-mx-1 mb-6 overflow-x-auto border-b">
        <div className="flex min-w-max gap-1 px-1">
          {tabs.map((t) => {
            const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
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
