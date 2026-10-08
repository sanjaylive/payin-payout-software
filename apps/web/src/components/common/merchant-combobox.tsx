'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Popover, PopoverContent, PopoverTrigger } from '@pay2all/ui/components/ui/popover';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, ChevronsUpDown, Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import type { MerchantSummary } from '@/lib/api/types';

export interface MerchantPick {
  id: string;
  name: string;
}

/**
 * Search-as-you-type merchant picker for large merchant lists: the server searches (name, legal
 * name, PAN or exact ID) and returns 20 at a time, so it scales to any number of merchants.
 * Keyboard: type, ↑/↓ to move, Enter to choose, Esc to close.
 */
export function MerchantCombobox({
  value,
  onChange,
  status,
  anyLabel,
  placeholder = 'Search merchants…',
  className,
  disabled,
  ariaLabel = 'Merchant',
}: {
  value: string | null;
  onChange: (merchant: MerchantPick | null) => void;
  /** Comma-separated merchant statuses to offer, e.g. "APPROVED,SUSPENDED". */
  status?: string;
  /** Offer a "nobody in particular" choice (value null), e.g. "Any merchant". */
  anyLabel?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  // Debounced in the input handler: one search per pause in typing, not per keystroke.
  const [search, setSearch] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const type = (v: string) => {
    setTerm(v);
    setActive(0);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) setSearch('');
    else timer.current = setTimeout(() => setSearch(v.trim()), 250);
  };
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [picked, setPicked] = useState<MerchantPick | null>(null);

  const qc = useQueryClient();
  const searchFn = (t: string) => api.list<MerchantSummary>('/v1/merchants', { search: t || undefined, status, limit: 20 });

  const results = useQuery({
    queryKey: ['merchant-search', status ?? '', search],
    queryFn: () => searchFn(search),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // The chosen merchant's name when the value came from outside (e.g. editing a saved record).
  const known = useQuery({
    queryKey: ['merchant-search', 'by-id', value],
    queryFn: () => api.list<MerchantSummary>('/v1/merchants', { search: value!, limit: 1 }),
    enabled: !!value && picked?.id !== value,
    staleTime: 300_000,
  });
  const selectedName = value ? (picked?.id === value ? picked.name : (known.data?.data.find((m) => m.id === value)?.name ?? null)) : null;

  const rows = results.data?.data ?? [];
  // Results not yet for what's typed (debounce pending or request in flight): never let Enter pick from them.
  const stale = term.trim() !== search || results.isPlaceholderData;
  const options: (MerchantSummary | null)[] = anyLabel ? [null, ...rows] : rows;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(m: MerchantSummary | null) {
    const pick = m ? { id: m.id, name: m.name } : null;
    setPicked(pick);
    onChange(pick);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setActive(0);
        // Fresh search on every open (resetting on close would flash the full list while it fades out).
        if (o) type('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          className={cn(
            'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 items-center gap-2 rounded-md border px-3 text-left text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <Building2 className="text-muted-foreground size-4 shrink-0" />
          <span className={cn('min-w-0 flex-1 truncate', !value && !anyLabel && 'text-muted-foreground')}>{value ? (selectedName ?? 'Loading…') : (anyLabel ?? placeholder)}</span>
          {value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear merchant"
              onClick={(e) => {
                e.stopPropagation();
                choose(null);
              }}
              className="text-muted-foreground hover:text-foreground rounded p-0.5"
            >
              <X className="size-3.5" />
            </span>
          )}
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
            aria-label={`Search ${ariaLabel.toLowerCase()}`}
            value={term}
            onChange={(e) => type(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, options.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (stale) {
                  // Results are for older text: search exactly what's typed now, then take the top match.
                  const t = term.trim();
                  if (timer.current) clearTimeout(timer.current);
                  setSearch(t);
                  void qc.fetchQuery({ queryKey: ['merchant-search', status ?? '', t], queryFn: () => searchFn(t), staleTime: 30_000 }).then((r) => r.data[0] && choose(r.data[0]));
                } else if (options.length) choose(options[active] ?? null);
              }
            }}
            placeholder="Name, legal name, PAN or ID"
            className="placeholder:text-muted-foreground h-10 w-full bg-transparent text-sm outline-none"
          />
          {results.isFetching && <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />}
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} aria-busy={stale} className={cn('max-h-72 overflow-y-auto p-1 transition-opacity', stale && 'opacity-50')}>
          {options.map((m, i) => {
            const selected = m ? m.id === value : !value;
            return (
              <li
                key={m?.id ?? '__any__'}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(m)}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-accent text-accent-foreground')}
              >
                <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                {m ? (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="text-muted-foreground block truncate text-[11px]">
                      {[m.legal_name && m.legal_name !== m.name ? m.legal_name : null, m.reseller ? `via ${m.reseller.name}` : null, `…${m.id.slice(-6)}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                ) : (
                  <span className="flex-1 font-medium">{anyLabel}</span>
                )}
                {m && m.status !== 'APPROVED' && <StatusBadge status={m.status} className="shrink-0" />}
              </li>
            );
          })}
          {!results.isLoading && rows.length === 0 && <li className="text-muted-foreground px-3 py-6 text-center text-sm">{search ? `No merchants match “${search}”` : 'No merchants'}</li>}
          {results.isLoading && <li className="text-muted-foreground px-3 py-6 text-center text-sm">Searching…</li>}
        </ul>
        {!!results.data?.meta?.has_more && <p className="text-muted-foreground border-t px-3 py-1.5 text-[11px]">Showing the first 20 — type to narrow down.</p>}
      </PopoverContent>
    </Popover>
  );
}
