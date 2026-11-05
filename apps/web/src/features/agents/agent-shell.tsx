'use client';

import { Sheet, SheetContent, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { cn } from '@pay2all/ui/lib/utils';
import { Contact, LayoutDashboard, Menu, Plus, Receipt } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, Suspense, useState } from 'react';
import { AGENT_NAV } from '@/components/shell/nav-config';
import { Sidebar } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/shell/user-menu';
import type { Me } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

/**
 * The agent counter. Desktop: the usual sidebar. Phones: a compact header and a bottom tab bar with
 * a big "New" button, because most agents record entries one-handed at the counter.
 */
export function AgentShell({ me, children }: { me: Me; children: ReactNode }) {
  const pathname = usePathname();
  const can = useCan();
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const moreOpen = openedOn === pathname;
  const setMoreOpen = (open: boolean) => setOpenedOn(open ? pathname : null);

  const sidebar = (
    <Suspense>
      <Sidebar nav={AGENT_NAV} />
    </Suspense>
  );

  const tab = (href: string, label: string, Icon: typeof Receipt, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-primary' : 'text-muted-foreground')}
    >
      <Icon className="size-5" aria-hidden />
      {label}
    </Link>
  );

  return (
    <div className="flex h-dvh overflow-hidden print:block print:h-auto print:overflow-visible">
      <div className="hidden lg:block print:hidden">{sidebar}</div>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="left" className="w-64 border-none p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col print:block">
        <header className="bg-card/80 supports-[backdrop-filter]:bg-card/60 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur lg:h-16 lg:px-8 print:hidden">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me.organization.name}</p>
            <p className="text-muted-foreground text-xs">Agent counter</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <UserMenu me={me} securityHref="/agent/security" />
          </div>
        </header>
        <main className="relative flex-1 overflow-y-auto print:overflow-visible">
          <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-28 lg:px-8 lg:py-8 print:p-0">{children}</div>
        </main>
      </div>

      <nav
        aria-label="Counter"
        className="bg-card/95 supports-[backdrop-filter]:bg-card/80 fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden print:hidden"
      >
        {tab('/agent', 'Home', LayoutDashboard, pathname === '/agent')}
        {tab('/agent/transactions', 'Entries', Receipt, pathname.startsWith('/agent/transactions') || pathname.startsWith('/agent/receipts'))}
        {can('agent.desk.write') ? (
          <Link href="/agent/new" aria-label="New transaction" className="flex flex-1 items-center justify-center">
            <span className={cn('bg-primary text-primary-foreground -mt-6 grid size-14 place-items-center rounded-full shadow-lg ring-4 ring-background', pathname === '/agent/new' && 'opacity-90')}>
              <Plus className="size-7" aria-hidden />
            </span>
          </Link>
        ) : null}
        {tab('/agent/customers', 'Customers', Contact, pathname.startsWith('/agent/customers'))}
        <button type="button" onClick={() => setMoreOpen(true)} className="text-muted-foreground flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium">
          <Menu className="size-5" aria-hidden />
          More
        </button>
      </nav>
    </div>
  );
}
