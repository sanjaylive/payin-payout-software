'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { assetUrl } from '@/lib/brand/brand';
import { useBrand } from '@/lib/brand/brand-provider';

/** The built-in mark: two interlocking arrows (collect + pay out). */
export function DefaultMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 13h11l-3.5-3.5M23 19H12l3.5 3.5" fill="none" className="stroke-primary-foreground" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Logo from Settings → Brand. `inverted` = on a dark surface (sidebar, sign-in panel): the dark-background
 * logo is used there; elsewhere the light logo, switching to the dark one in dark mode. Without an
 * uploaded logo: the icon (or built-in mark) and the product name.
 */
export function Brand({ className, inverted }: { className?: string; inverted?: boolean }) {
  const b = useBrand();
  const light = assetUrl(b.assets.logo);
  const dark = assetUrl(b.assets.logo_dark);
  const icon = assetUrl(b.assets.icon);
  const img = 'h-8 w-auto max-w-[200px] object-contain';

  const main = inverted ? dark : light;
  if (main) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with its own caching */}
        <img src={main} alt={b.product_name} className={cn(img, !inverted && dark && 'dark:hidden')} />
        {!inverted && dark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dark} alt={b.product_name} className={cn(img, 'hidden dark:block')} />
        )}
      </span>
    );
  }

  const rest = b.product_name.startsWith(`${b.short_name} `) ? b.product_name.slice(b.short_name.length + 1) : null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 font-semibold tracking-tight', className)}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="size-7 shrink-0 rounded-md object-contain" />
      ) : (
        <DefaultMark />
      )}
      <span className={cn('truncate text-[15px]', inverted ? 'text-white' : 'text-foreground')}>
        {rest ? (
          <>
            {b.short_name} <span className={inverted ? 'text-sidebar-muted font-medium' : 'text-muted-foreground font-medium'}>{rest}</span>
          </>
        ) : (
          b.product_name
        )}
      </span>
    </span>
  );
}
