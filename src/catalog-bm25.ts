import { DatabaseSync } from 'node:sqlite';
import type { CliCatalogEntry } from './cli-catalog.js';

export type CatalogMatchChannel = 'name' | 'bm25';

export interface CatalogRecallMatch {
  entry: CliCatalogEntry;
  channels: CatalogMatchChannel[];
  matchedTerms: string[];
}

const genericDescriptionMarkers = [
  '已在有效 PATH 发现可执行命令；用途资料未知',
  '按所引资料核对参数',
  '当前只有包级说明',
];
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function isGenericCatalogUsage(entry: CliCatalogEntry): boolean {
  if (genericDescriptionMarkers.some(marker => entry.description.includes(marker))) return true;
  const scenarios = entry.scenarios ?? [];
  return scenarios.length > 0 && scenarios.every(text => genericDescriptionMarkers.some(marker => text.includes(marker)));
}

function searchableFields(entry: CliCatalogEntry): { command: string; body: string } {
  const bodyParts: string[] = [];
  if (!isGenericCatalogUsage(entry)) {
    bodyParts.push(entry.description);
    for (const scenario of entry.scenarios ?? []) {
      if (!genericDescriptionMarkers.some(marker => scenario.includes(marker))) bodyParts.push(scenario);
    }
    for (const domain of entry.domains ?? []) bodyParts.push(domain);
    for (const requirement of entry.requirements ?? []) bodyParts.push(requirement);
  }
  return { command: entry.command, body: bodyParts.join(' ') };
}

function segmentTerms(text: string): string[] {
  const lowered = text.trim().toLowerCase();
  if (!lowered) return [];
  const pieces = lowered.split(/[\s,，、;/|]+/u).flatMap(part => {
    try {
      return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(part)]
        .filter(word => word.isWordLike).map(word => word.segment.toLowerCase());
    } catch {
      return part ? [part] : [];
    }
  });
  const stop = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'from', 'is', 'are', '的', '了', '和', '或', '与']);
  return [...new Set(pieces.filter(term => term.length >= 2 && term.length <= 128 && !stop.has(term)))];
}

function ftsEscape(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function ftsQuery(terms: string[]): string | undefined {
  const unique = [...new Set(terms.map(term => term.trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return undefined;
  return unique.map(ftsEscape).join(' OR ');
}

function bm25Matches(entries: readonly CliCatalogEntry[], terms: string[]): Map<string, { matchedTerms: string[] }> {
  const query = ftsQuery(terms);
  if (!query) return new Map();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE catalog_fts USING fts5(command UNINDEXED, body, tokenize=\'unicode61\')');
  const insert = db.prepare('INSERT INTO catalog_fts(rowid, command, body) VALUES (?, ?, ?)');
  const searchable = entries.map((entry, index) => ({ index, entry, fields: searchableFields(entry) }));
  for (const item of searchable) insert.run(item.index + 1, item.fields.command, item.fields.body);
  const rows = db.prepare('SELECT rowid FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY bm25(catalog_fts)')
    .all(query) as { rowid: number }[];
  const result = new Map<string, { matchedTerms: string[] }>();
  for (const row of rows) {
    const entry = searchable[row.rowid - 1]?.entry;
    if (!entry) continue;
    const matchedTerms = terms.filter(term => {
      const fields = searchableFields(entry);
      const haystack = `${fields.command} ${fields.body}`.toLowerCase();
      return haystack.includes(term.toLowerCase());
    });
    if (matchedTerms.length) result.set(entry.command, { matchedTerms });
  }
  return result;
}

export function recallCatalogEntries(entries: readonly CliCatalogEntry[], input: {
  query?: string;
  terms?: string[];
  commands?: string[];
}): { matches: CatalogRecallMatch[]; unregisteredNames: string[]; recallTerms: string[]; queried: boolean } {
  const byCommand = new Map(entries.map(entry => [entry.command, entry]));
  const nameHints = [...new Set((input.commands ?? []).map(command => command.trim()).filter(command => commandPattern.test(command)))];
  const recallTerms = [...new Set([
    ...segmentTerms(input.query ?? ''),
    ...(input.terms ?? []).flatMap(term => segmentTerms(term)),
  ])];
  const hasNames = nameHints.length > 0;
  const hasRecall = recallTerms.length > 0;
  if (!hasNames && !hasRecall) return { matches: [], unregisteredNames: [], recallTerms: [], queried: false };
  const bm25 = hasRecall ? bm25Matches(entries, recallTerms) : new Map<string, { matchedTerms: string[] }>();
  const merged = new Map<string, CatalogRecallMatch>();
  const unregisteredNames: string[] = [];
  for (const command of nameHints) {
    const entry = byCommand.get(command);
    if (!entry) { unregisteredNames.push(command); continue; }
    merged.set(command, { entry, channels: ['name' as const], matchedTerms: [command] });
  }
  for (const [command, hit] of bm25) {
    const entry = byCommand.get(command);
    if (!entry) continue;
    const existing = merged.get(command);
    if (existing) {
      existing.channels = [...new Set([...existing.channels, 'bm25' as const])];
      existing.matchedTerms = [...new Set([...existing.matchedTerms, ...hit.matchedTerms])];
    } else {
      merged.set(command, { entry, channels: ['bm25' as const], matchedTerms: hit.matchedTerms });
    }
  }
  const matches = [...merged.values()].sort((a, b) => {
    const channelScore = (channels: CatalogMatchChannel[]) => (channels.includes('name') ? 0 : 1);
    const delta = channelScore(a.channels) - channelScore(b.channels);
    if (delta) return delta;
    return a.entry.command < b.entry.command ? -1 : a.entry.command > b.entry.command ? 1 : 0;
  });
  return { matches, unregisteredNames, recallTerms, queried: true };
}
