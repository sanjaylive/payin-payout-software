'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { BookOpen } from 'lucide-react';
import Link from 'next/link';
import { Brand } from '@/components/shell/brand';
import { useBrand } from '@/lib/brand/brand-provider';
import { ApiReference } from './api-reference';

export function DocsShell() {
  const b = useBrand();
  return (
    <div className="bg-background min-h-dvh">
      <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 lg:px-8">
          <Link href="/docs" className="min-w-0">
            <Brand />
          </Link>
          <span className="text-muted-foreground hidden items-center gap-1.5 border-l pl-4 text-sm font-medium sm:inline-flex">
            <BookOpen className="size-4" /> Developers
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/developers/api-keys">Get API keys</Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
        <ApiReference />
      </main>
      <footer className="text-muted-foreground border-t py-6 text-center text-xs">
        © {new Date().getFullYear()} {b.company_name}
        {b.support_email && (
          <>
            {' · '}
            <a href={`mailto:${b.support_email}`} className="hover:text-foreground">
              {b.support_email}
            </a>
          </>
        )}
      </footer>
    </div>
  );
}
