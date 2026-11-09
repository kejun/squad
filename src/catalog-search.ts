import { createHash } from 'node:crypto';

export const normalizeCatalogQuery = (query = '') => query.trim().toLowerCase().split(/\s+/u).filter(Boolean).sort().join(' ');
export function matchesCatalogQuery(metadata: string, query: string): boolean {
  const text = metadata.toLowerCase();
  return query.split(' ').filter(Boolean).every(term => text.includes(term));
}

/** Cursors are observations bound to one query and immutable catalog, never authority. */
export function catalogWindow<T>(entries: T[], catalogVersion: string, query: string, cursor: string | undefined,
  invalidCursor: () => Error): { entries: T[]; nextCursor: string | null } {
  const key = createHash('sha256').update(JSON.stringify([catalogVersion, query])).digest('hex');
  const offset = cursor === undefined ? 0 : Number(cursor.split(':')[1]);
  if (cursor !== undefined && (cursor !== `${key}:${offset}` || !Number.isSafeInteger(offset)
    || offset <= 0 || offset % 20 !== 0 || offset >= entries.length)) throw invalidCursor();
  const end = offset + 20;
  return { entries: entries.slice(offset, end), nextCursor: end < entries.length ? `${key}:${end}` : null };
}
