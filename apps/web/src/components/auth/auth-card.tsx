import type { ReactNode } from 'react';
import { Brand } from '../shell/brand';

/** Split layout for sign-in screens: brand panel + form. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(480px,560px)]">
      <section className="bg-sidebar relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Brand inverted />
        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl leading-tight font-semibold text-white">Collections, payouts and settlements — on one reliable ledger.</h2>
          <p className="text-sidebar-muted mt-4 text-sm leading-relaxed">
            Every rupee is double-entry accounted, every action is audited, and every API call is idempotent.
          </p>
        </div>
        <p className="text-sidebar-muted text-xs">© {new Date().getFullYear()} Pay2All Services Pvt. Ltd.</p>
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
        </div>
      </section>
    </div>
  );
}
