'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { cn } from '@pay2all/ui/lib/utils';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import type { ApiSuccess, PaginationMeta } from '@pay2all/types';
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  BellOff,
  CheckCheck,
  FileCheck2,
  FileSpreadsheet,
  Info,
  Landmark,
  Loader2,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  Webhook,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import type { InboxCategory, InboxItem, InboxSeverity } from '@/lib/api/types';
import { INBOX_KEY, UNREAD_KEY, useInboxStream } from './use-inbox-stream';

type Page = ApiSuccess<InboxItem[], PaginationMeta>;

const ICONS: Record<InboxCategory, LucideIcon> = {
  PAYMENT: ArrowDownToLine,
  PAYOUT: ArrowUpFromLine,
  SETTLEMENT: Landmark,
  RISK: ShieldAlert,
  SECURITY: ShieldCheck,
  COMPLIANCE: FileCheck2,
  WEBHOOK: Webhook,
  REPORT: FileSpreadsheet,
  SYSTEM: Info,
  WALLET: Wallet,
};

const TONE: Record<InboxSeverity, string> = {
  INFO: 'bg-info-muted text-info',
  SUCCESS: 'bg-success-muted text-success',
  WARNING: 'bg-warning-muted text-warning-foreground dark:text-warning',
  CRITICAL: 'bg-danger-muted text-destructive',
};

function dayGroup(iso: string): string {
  const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const day = ist(new Date(iso));
  const today = ist(new Date());
  const yesterday = ist(new Date(Date.now() - 86_400_000));
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : 'Earlier';
}

function Item({ n, onOpen, onToggle }: { n: InboxItem; onOpen: (n: InboxItem) => void; onToggle: (n: InboxItem) => void }) {
  const Icon = ICONS[n.category];
  return (
    <li className={cn('group relative flex gap-3 px-4 py-3 transition-colors', n.read ? 'hover:bg-muted/50' : 'bg-primary/[0.04] hover:bg-primary/[0.08]')}>
      <span className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-full', TONE[n.severity])}><Icon className="size-4" aria-hidden /></span>
      <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:underline" onClick={() => onOpen(n)}>
        <p className={cn('text-sm leading-snug', n.read ? 'text-foreground/90' : 'font-semibold')}>{n.title}</p>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">{n.body}</p>
        <p className="text-muted-foreground mt-1 text-[11px]" title={formatDateTime(n.created_at)}>{formatRelative(n.created_at)}</p>
      </button>
      <div className="flex flex-col items-end gap-2">
        {!n.read && <span className="bg-primary mt-1.5 size-2 rounded-full" aria-label="Unread" />}
        <button
          type="button"
          onClick={() => onToggle(n)}
          className="text-muted-foreground hover:text-foreground text-[11px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          {n.read ? 'Mark unread' : 'Mark read'}
        </button>
      </div>
    </li>
  );
}

/**
 * Header bell + right-hand drawer. The unread badge and list update in real time from the inbox
 * stream (Server-Sent Events) — no polling, no refresh. New items also pop a toast while the drawer
 * is closed, and the tab title shows the unread count.
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const unreadOnly = tab === 'unread';

  const status = useInboxStream((n) => {
    if (open) return;
    toast(n.title, {
      description: n.body,
      icon: (() => { const I = ICONS[n.category]; return <I className="size-4" />; })(),
      action: n.link ? { label: 'View', onClick: () => router.push(n.link!) } : undefined,
    });
  });

  const unread = useQuery({ queryKey: UNREAD_KEY, queryFn: () => api.get<{ unread: number }>('/v1/inbox/unread-count'), staleTime: Infinity });
  const list = useInfiniteQuery({
    queryKey: [...INBOX_KEY, 'list', unreadOnly],
    queryFn: ({ pageParam }) => api.list<InboxItem>('/v1/inbox', { limit: 20, ...(pageParam ? { cursor: pageParam } : {}), ...(unreadOnly ? { unread: 'true' } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    enabled: open,
    staleTime: Infinity,
  });

  const count = unread.data?.unread ?? 0;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\) /, '');
    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
  }, [count]);

  const patchItem = (id: string, read: boolean) => {
    for (const u of [false, true]) {
      qc.setQueryData<InfiniteData<Page>>([...INBOX_KEY, 'list', u], (cur) =>
        cur ? { ...cur, pages: cur.pages.map((p) => ({ ...p, data: p.data.map((x) => (x.id === id ? { ...x, read, read_at: read ? new Date().toISOString() : null } : x)) })) } : cur,
      );
    }
  };

  async function toggle(n: InboxItem) {
    patchItem(n.id, !n.read);
    qc.setQueryData(UNREAD_KEY, { unread: Math.max(0, count + (n.read ? 1 : -1)) });
    const res = await api.post<{ unread: number }>(`/v1/inbox/${n.id}/${n.read ? 'unread' : 'read'}`).catch(() => null);
    if (res) qc.setQueryData(UNREAD_KEY, res);
  }

  async function openItem(n: InboxItem) {
    if (!n.read) void toggle(n);
    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  }

  async function markAll() {
    qc.setQueryData(UNREAD_KEY, { unread: 0 });
    for (const u of [false, true]) {
      qc.setQueryData<InfiniteData<Page>>([...INBOX_KEY, 'list', u], (cur) => (cur ? { ...cur, pages: cur.pages.map((p) => ({ ...p, data: u ? [] : p.data.map((x) => ({ ...x, read: true })) })) } : cur));
    }
    await api.post('/v1/inbox/read-all').catch(() => undefined);
  }

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: InboxItem[] }> = [];
    for (const n of items) {
      const label = dayGroup(n.created_at);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items]);

  return (
    <>
      <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}>
        <Bell />
        {count > 0 && (
          <span className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-[var(--card)]">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b px-4 py-4">
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle className="flex items-center gap-2">
                Notifications
                <span className={cn('inline-flex items-center gap-1 text-[11px] font-normal', status === 'live' ? 'text-success' : 'text-muted-foreground')} title={status === 'live' ? 'Updates arrive instantly' : 'Reconnecting…'}>
                  <span className={cn('size-1.5 rounded-full', status === 'live' ? 'bg-success animate-pulse' : 'bg-muted-foreground')} />
                  {status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Connecting'}
                </span>
              </SheetTitle>
              <Button size="sm" variant="ghost" disabled={count === 0} onClick={() => void markAll()}><CheckCheck /> Mark all as read</Button>
            </div>
            <SheetDescription className="sr-only">Your recent notifications</SheetDescription>
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-2">
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="unread">Unread{count > 0 ? ` (${count > 99 ? '99+' : count})` : ''}</TabsTrigger>
              </TabsList>
            </Tabs>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            {list.isPending ? (
              <div className="grid h-40 place-items-center"><Loader2 className="text-muted-foreground size-5 animate-spin" /></div>
            ) : items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <span className="bg-muted grid size-12 place-items-center rounded-full"><BellOff className="text-muted-foreground size-5" /></span>
                <p className="text-sm font-medium">{unreadOnly ? 'You’re all caught up' : 'No notifications yet'}</p>
                <p className="text-muted-foreground text-xs">Approvals, failed payouts, settlements and security alerts appear here the moment they happen.</p>
              </div>
            ) : (
              <>
                {groups.map((g) => (
                  <section key={g.label}>
                    <h3 className="bg-card/95 text-muted-foreground sticky top-0 z-10 border-b px-4 py-1.5 text-[11px] font-semibold tracking-wide uppercase backdrop-blur">{g.label}</h3>
                    <ul className="divide-y">{g.items.map((n) => <Item key={n.id} n={n} onOpen={(x) => void openItem(x)} onToggle={(x) => void toggle(x)} />)}</ul>
                  </section>
                ))}
                {list.hasNextPage && (
                  <div className="p-3 text-center">
                    <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage && <Loader2 className="animate-spin" />} Load older</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
