'use client';

import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

export interface DetailField {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/**
 * Side drawer for record details (transactions, audit entries). Sections of label/value pairs plus
 * optional free-form children (timelines, JSON payloads).
 */
export function TransactionDetailsDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  sections,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  sections: { title: string; fields: DetailField[] }[];
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          {subtitle && <SheetDescription asChild><div>{subtitle}</div></SheetDescription>}
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {sections.map((s) => (
            <section key={s.title}>
              <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">{s.title}</h4>
              <dl className="divide-y rounded-lg border">
                {s.fields.map((f) => (
                  <div key={f.label} className="grid grid-cols-3 gap-3 px-3 py-2 text-sm">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className={`col-span-2 break-all ${f.mono ? 'font-mono text-xs leading-5' : ''}`}>{f.value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
