/** Deterministic lexical hints over already loaded metadata, never capability or execution proof. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stopWords = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'from', 'is', 'are', 'please', 'use', 'https', 'http']);
export function recommendMetadata<T>(entries: readonly T[], objective: string, metadata: (entry: T) => string, identity: (entry: T) => string) {
  const terms = [...new Set([...segmenter.segment(objective.slice(0, 12_000).toLowerCase())]
    .filter(word => word.isWordLike && word.segment.length >= 2 && word.segment.length <= 128 && !stopWords.has(word.segment))
    .map(word => word.segment))].slice(0, 32);
  const matches = entries.map(entry => ({ entry, matchedTerms: terms.filter(term => metadata(entry).toLowerCase().includes(term)) }))
    .filter(match => match.matchedTerms.length > 0)
    .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || compare(identity(a.entry), identity(b.entry)));
  return { candidates: matches.slice(0, 5).map(({ entry, matchedTerms }) => ({ ...structuredClone(entry), matchedTerms })), omitted: matches.length > 5 };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
