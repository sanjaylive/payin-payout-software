import type { ReactNode } from 'react';

/** Page title (h1), or a section title (h2) inside a page that already has one — e.g. a Settings tab. */
export function PageHeader({ title, description, actions, level = 1 }: { title: string; description?: ReactNode; actions?: ReactNode; level?: 1 | 2 }) {
  return (
    <div className={`${level === 1 ? 'mb-6' : 'mb-4'} flex flex-wrap items-end justify-between gap-4`}>
      <div>
        {level === 1 ? <h1 className="text-2xl font-semibold tracking-tight">{title}</h1> : <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
