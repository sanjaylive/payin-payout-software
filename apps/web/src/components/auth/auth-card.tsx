'use client';

import type { ReactNode } from 'react';
import { useBrand } from '@/lib/brand/brand-provider';
import { Brand } from '../shell/brand';

/** Split layout for sign-in screens: brand panel + form. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const b = useBrand();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(480px,560px)]">
      <section className="bg-sidebar relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Brand inverted />
        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl leading-tight font-semibold text-white">{b.login_headline}</h2>
          {b.login_subtext && <p className="text-sidebar-muted mt-4 text-sm leading-relaxed">{b.login_subtext}</p>}
        </div>
        <div className="text-sidebar-muted space-y-1 text-xs">
          <p>
            © {new Date().getFullYear()} {b.company_name}
            {b.website_url && (
              <>
                {' · '}
                <a href={b.website_url} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                  {b.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              </>
            )}
          </p>
          {b.footer_text && <p>{b.footer_text}</p>}
        </div>
        <svg className="absolute -right-24 -bottom-24 size-[28rem] opacity-[0.07]" viewBox="0 0 32 32" aria-hidden>
          <path d="M9 13h11l-3.5-3.5M23 19H12l3.5 3.5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Brand /></div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground mt-1.5 text-sm">{description}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="text-muted-foreground mt-6 text-sm">{footer}</div>}
          {(b.support_email || b.support_phone) && (
            <p className="text-muted-foreground mt-10 text-xs">
              Need help?{' '}
              {b.support_email && (
                <a href={`mailto:${b.support_email}`} className="text-foreground font-medium hover:underline">
                  {b.support_email}
                </a>
              )}
              {b.support_email && b.support_phone && ' · '}
              {b.support_phone && (
                <a href={`tel:${b.support_phone.replace(/[\s-]/g, '')}`} className="text-foreground font-medium hover:underline">
                  {b.support_phone}
                </a>
              )}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
