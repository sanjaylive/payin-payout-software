import type { PaginationMeta } from '@pay2all/types';

/** Returned by list handlers; the envelope interceptor unwraps it into { data, meta }. */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly meta: PaginationMeta,
  ) {}
}

interface CursorPayload {
  t: string;
  i: string;
}

/** Opaque keyset cursor over (createdAt DESC, id DESC). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id } satisfies CursorPayload)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return null;
    const createdAt = new Date(parsed.t);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** Prisma `where` fragment for "rows after cursor" in (createdAt DESC, id DESC) order. */
export function keysetAfter(cursor: { createdAt: Date; id: string } | null) {
  if (!cursor) return {};
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  };
}

/** Fetch limit+1 rows, then call this to build the page. */
export function toPage<R extends { createdAt: Date; id: string }, T>(
  rows: R[],
  limit: number,
  present: (row: R) => T,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return new Paginated(pageRows.map(present), {
    limit,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}
