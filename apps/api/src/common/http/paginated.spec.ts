import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, toPage } from './paginated';

describe('keyset cursors', () => {
  it('round-trips', () => {
    const at = new Date('2026-10-06T10:00:00.123Z');
    expect(decodeCursor(encodeCursor(at, 'aud_1'))).toEqual({ createdAt: at, id: 'aud_1' });
  });

  it('treats garbage as no cursor', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"nope","i":"x"}').toString('base64url'))).toBeNull();
  });

  it('builds pages from limit+1 rows', () => {
    const rows = [3, 2, 1].map((n) => ({ id: `id${n}`, createdAt: new Date(n * 1000) }));
    const page = toPage(rows, 2, (r) => r.id);
    expect(page.items).toEqual(['id3', 'id2']);
    expect(page.meta.has_more).toBe(true);
    expect(decodeCursor(page.meta.next_cursor!)?.id).toBe('id2');
    expect(toPage(rows.slice(0, 2), 2, (r) => r.id).meta).toMatchObject({ has_more: false, next_cursor: null });
  });
});
