'use client';

import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { buildUrl, refreshSession } from '@/lib/api/client';
import type { InboxItem } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth/store';
import type { ApiSuccess, PaginationMeta } from '@pay2all/types';

export const INBOX_KEY = ['inbox'] as const;
export const UNREAD_KEY = ['inbox', 'unread'] as const;

type Page = ApiSuccess<InboxItem[], PaginationMeta>;
export type StreamStatus = 'connecting' | 'live' | 'offline';

/**
 * One live connection per tab to /v1/inbox/stream (Server-Sent Events, read with fetch so the
 * bearer token can be sent). New notifications are merged into the cached list and unread count —
 * nothing polls. Reconnects with backoff; refreshes the access token on 401; resyncs on `resync`.
 */
export function useInboxStream(onNotification: (n: InboxItem) => void) {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onNotification);
  handler.current = onNotification;

  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    let retry = 1_000;

    const apply = (event: string, data: string) => {
      if (event === 'ready') {
        const { unread } = JSON.parse(data) as { unread: number };
        qc.setQueryData(UNREAD_KEY, { unread });
        setStatus('live');
        retry = 1_000;
      } else if (event === 'notification') {
        const n = JSON.parse(data) as InboxItem;
        for (const unreadOnly of [false, true]) {
          qc.setQueryData<InfiniteData<Page>>([...INBOX_KEY, 'list', unreadOnly], (cur) => {
            if (!cur?.pages.length) return cur;
            if (cur.pages.some((p) => p.data.some((x) => x.id === n.id))) return cur;
            const [first, ...rest] = cur.pages;
            return { ...cur, pages: [{ ...first!, data: [n, ...first!.data] }, ...rest] };
          });
        }
        qc.setQueryData<{ unread: number }>(UNREAD_KEY, (c) => ({ unread: (c?.unread ?? 0) + 1 }));
        handler.current(n);
      } else if (event === 'resync') {
        void qc.invalidateQueries({ queryKey: INBOX_KEY });
      }
    };

    const run = async () => {
      while (!abort.signal.aborted) {
        try {
          const current = useAuthStore.getState().accessToken;
          const res = await fetch(buildUrl('/v1/inbox/stream'), { headers: { Authorization: `Bearer ${current ?? ''}`, Accept: 'text/event-stream' }, credentials: 'include', signal: abort.signal, cache: 'no-store' });
          if (res.status === 401) {
            // A refreshed token re-runs this effect with a fresh connection; a failed refresh means
            // the session is over and the auth gate takes the user to sign-in.
            await refreshSession();
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const event = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (event && data) apply(event, data);
            }
          }
          // Server recycled the stream (every 10 min): reconnect straight away.
          setStatus('connecting');
        } catch {
          if (abort.signal.aborted) return;
          setStatus('offline');
          await new Promise((r) => setTimeout(r, retry));
          retry = Math.min(retry * 2, 30_000);
        }
      }
    };
    void run();
    // A connection may have missed events while offline: resync once it's back.
    const online = () => void qc.invalidateQueries({ queryKey: INBOX_KEY });
    window.addEventListener('online', online);
    return () => {
      abort.abort();
      window.removeEventListener('online', online);
    };
  }, [token, qc]);

  return status;
}
