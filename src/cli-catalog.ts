import { createHash } from 'node:crypto';
import { catalogWindow, matchesCatalogQuery, normalizeCatalogQuery } from './catalog-search.js';
import { recommendMetadata } from './tool-recommendation.js';

export interface CliCatalogEntry {
  command: string;
  description: string;
  domains?: string[];
  helpArgs?: string[];
  examples?: { description: string; args: string[] }[];
  execution?: 'sandbox' | 'host';
  requirements?: string[];
}
export interface CliCatalogConfiguration { state: 'unconfigured' | 'empty' | 'configured'; entryCount: number }
export interface CliCatalogPage { catalogVersion: string; entries: CliCatalogEntry[]; nextCursor: string | null; configuration?: CliCatalogConfiguration }
export class CliCatalogError extends Error { constructor(readonly code: string) { super(code); } }
const text = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const args = (value: unknown) => Array.isArray(value) && value.length <= 128
  && value.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'));
const list = (value: unknown) => Array.isArray(value) && value.length <= 20 && value.every(item => text(item, 500));
const keys = new Set(['command', 'description', 'domains', 'helpArgs', 'examples', 'execution', 'requirements']);

/** Called only on trusted host configuration, never on model or skill output. Reject unknown fields to keep secrets out. */
export function parseCliCatalog(value: unknown): CliCatalogEntry[] {
  if (!Array.isArray(value) || value.length > 200 || JSON.stringify(value).length > 500_000) throw new CliCatalogError('CLI_CATALOG_INVALID');
  const commands = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CliCatalogError('CLI_CATALOG_INVALID');
    const item = entry as Record<string, unknown>;
    // Twenty entries stay below 40 KB, leaving room for capability and skill metadata in the receipt.
    if (JSON.stringify(item).length > 2000 || Object.keys(item).some(key => !keys.has(key)) || typeof item.command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(item.command)
      || commands.has(item.command) || !text(item.description, 2000)
      || item.domains !== undefined && (!list(item.domains) || !(item.domains as string[]).every(domain => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)))
      || item.helpArgs !== undefined && !args(item.helpArgs)
      || item.requirements !== undefined && !list(item.requirements)
      || item.execution !== undefined && item.execution !== 'sandbox' && item.execution !== 'host'
      || item.examples !== undefined && (!Array.isArray(item.examples) || item.examples.length > 10 || !item.examples.every(example => example && typeof example === 'object'
        && !Array.isArray(example) && Object.keys(example).every(key => ['description', 'args'].includes(key)) && text(example.description, 1000) && args(example.args)))) {
      throw new CliCatalogError('CLI_CATALOG_INVALID');
    }
    commands.add(item.command);
  }
  return structuredClone(value) as CliCatalogEntry[];
}

export class CliCatalog {
  readonly catalogVersion: string;
  readonly configuration: CliCatalogConfiguration;
  private readonly entries: CliCatalogEntry[];
  constructor(value?: unknown) {
    this.entries = parseCliCatalog(value === undefined ? [] : value);
    this.configuration = { state: value === undefined ? 'unconfigured' : this.entries.length ? 'configured' : 'empty', entryCount: this.entries.length };
    this.catalogVersion = createHash('sha256').update(JSON.stringify(this.entries)).digest('hex');
  }
  recommend(objective: string) {
    const matches = recommendMetadata(this.entries, objective,
      entry => [entry.command, entry.description, ...(entry.domains ?? []), ...(entry.requirements ?? [])].join(' '), entry => entry.command);
    return { catalogVersion: this.catalogVersion, configuration: structuredClone(this.configuration),
      matchState: matches.candidates.length ? 'matched' as const : 'no_match' as const, ...matches };
  }
  list({ query, cursor }: { query?: string; cursor?: string } = {}): CliCatalogPage {
    const q = normalizeCatalogQuery(query);
    const matches = this.entries.filter(entry => matchesCatalogQuery([entry.command, entry.description, ...(entry.domains ?? []),
      ...(entry.requirements ?? [])].join(' '), q));
    const page = catalogWindow(matches, this.catalogVersion, q, cursor, () => new CliCatalogError('CLI_CATALOG_CURSOR_INVALID'));
    return { catalogVersion: this.catalogVersion, configuration: structuredClone(this.configuration), entries: structuredClone(page.entries), nextCursor: page.nextCursor };
  }
}
