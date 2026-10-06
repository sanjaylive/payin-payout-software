'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useCan } from '@/lib/auth/use-me';
import { Brand } from './brand';
import type { NavItem, NavLeaf } from './nav-config';

function isActive(pathname: string, search: string, href: string): boolean {
  const [path, query] = href.split('?');
  if (query) return pathname === path && search.includes(query);
  return pathname === path && !search.includes('status=');
}

function PhaseTag({ phase }: { phase: number }) {
  if (phase <= 1) return null;
  return <span className="text-sidebar-muted ml-auto text-[10px] font-medium tabular-nums">P{phase}</span>;
}

export function Sidebar({ nav, footer }: { nav: NavItem[]; footer?: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const can = useCan();
  const visible = (leaf: Partial<NavLeaf>) => !leaf.permission || can(leaf.permission);

  const initiallyOpen = new Set(
    nav.filter((i) => i.children?.some((c) => isActive(pathname, search, c.href))).map((i) => i.label),
  );
  const [open, setOpen] = useState<Set<string>>(initiallyOpen);
  const toggle = (label: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-full w-64 flex-col">
      <div className="border-sidebar-border flex h-16 items-center border-b px-5">
        <Link href="/" aria-label="Pay2All home">
          <Brand inverted />
        </Link>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4" aria-label="Main">
        {nav.map((item) => {
          const Icon = item.icon;
          if (item.children) {
            const children = item.children.filter(visible);
            if (!children.length) return null;
            const expanded = open.has(item.label);
            return (
              <div key={item.label}>
                <button
                  type="button"
                  onClick={() => toggle(item.label)}
                  aria-expanded={expanded}
                  className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors"
                >
                  <Icon className="size-4 opacity-80" aria-hidden />
                  {item.label}
                  <ChevronDown className={cn('ml-auto size-4 opacity-60 transition-transform', expanded && 'rotate-180')} aria-hidden />
                </button>
                {expanded && (
                  <div className="border-sidebar-border mt-0.5 ml-5 space-y-0.5 border-l pl-3">
                    {children.map((c) => (
                      <Link
                        key={c.href}
                        href={c.href}
                        className={cn(
                          'hover:text-sidebar-accent-foreground flex items-center rounded-md px-3 py-1.5 text-sm transition-colors',
                          isActive(pathname, search, c.href) ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-sidebar-foreground/80',
                        )}
                      >
                        {c.label}
                        <PhaseTag phase={c.phase} />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (!visible(item) || !item.href) return null;
          const active = isActive(pathname, search, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="size-4 opacity-90" aria-hidden />
              {item.label}
              {item.phase !== undefined && <PhaseTag phase={item.phase} />}
            </Link>
          );
        })}
      </nav>
      {footer && <div className="border-sidebar-border border-t p-3">{footer}</div>}
    </aside>
  );
}
