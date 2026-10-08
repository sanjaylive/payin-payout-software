'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { type ReactNode, Suspense, useState } from 'react';
import type { Me } from '@/lib/api/types';
import type { NavItem } from './nav-config';
import { Sidebar } from './sidebar';
import { UserMenu } from './user-menu';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { useBrand } from '@/lib/brand/brand-provider';

const ORG_LABEL: Record<string, string> = { PLATFORM: 'Platform', RESELLER: 'Reseller', API_PARTNER: 'API Partner', MERCHANT: 'Merchant' };

export function AppShell({ me, nav, securityHref, children }: { me: Me; nav: NavItem[]; securityHref: string; children: ReactNode }) {
  const pathname = usePathname();
  // The mobile drawer belongs to the page it was opened on, so navigating closes it without an effect.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const mobileOpen = openedOn === pathname;
  const setMobileOpen = (open: boolean) => setOpenedOn(open ? pathname : null);

  const sidebar = (
    <Suspense>
      <Sidebar nav={nav} />
    </Suspense>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className="hidden lg:block">{sidebar}</div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 border-none p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-card/80 supports-[backdrop-filter]:bg-card/60 flex h-16 shrink-0 items-center gap-3 border-b px-4 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me.organization.name}</p>
            <p className="text-muted-foreground text-xs">{ORG_LABEL[me.organization.type]} account</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
            <UserMenu me={me} securityHref={securityHref} />
          </div>
        </header>
        {/* `relative` makes this scroll area the containing block for absolutely positioned
            descendants — notably the hidden native <select>/<input> Radix renders for Select and
            Switch. Without it they are placed against the document and stretch the page far below
            the shell (a long blank area under every long page). */}
        <main className="relative flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8 lg:py-8">{children}</div>
          <BrandFooter />
        </main>
      </div>
    </div>
  );
}

/** Company line and support contact from Settings → Brand. */
function BrandFooter() {
  const b = useBrand();
  return (
    <footer className="text-muted-foreground mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-4 text-xs lg:px-8">
      <span>
        © {new Date().getFullYear()} {b.company_name}
      </span>
      {b.footer_text && <span className="min-w-0">{b.footer_text}</span>}
      {(b.support_email || b.support_phone) && (
        <span className="sm:ml-auto">
          Support:{' '}
          {b.support_email && (
            <a href={`mailto:${b.support_email}`} className="hover:text-foreground underline-offset-2 hover:underline">
              {b.support_email}
            </a>
          )}
          {b.support_email && b.support_phone && ' · '}
          {b.support_phone && (
            <a href={`tel:${b.support_phone.replace(/[\s-]/g, '')}`} className="hover:text-foreground underline-offset-2 hover:underline">
              {b.support_phone}
            </a>
          )}
        </span>
      )}
    </footer>
  );
}
