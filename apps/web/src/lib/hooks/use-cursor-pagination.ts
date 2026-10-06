'use client';

import { useCallback, useState } from 'react';

/** Keyset pagination state: a stack of cursors so "Previous" works without offset queries. */
export function useCursorPagination() {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  const next = useCallback((nextCursor: string | null | undefined) => {
    if (nextCursor) setStack((s) => [...s, nextCursor]);
  }, []);
  const previous = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const reset = useCallback(() => setStack([undefined]), []);
  return { cursor, page: stack.length, hasPrevious: stack.length > 1, next, previous, reset };
}
