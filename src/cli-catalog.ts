import { createHash } from 'node:crypto';
import { catalogWindow, matchesCatalogQuery, normalizeCatalogQuery } from './catalog-search.js';
import { recallCatalogEntries, type CatalogRecallMatch } from './catalog-bm25.js';
import { recommendMetadata } from './tool-recommendation.js';

export interface CliUsageMetadata {
  description: string;
  scenarios?: string[];
  documentation?: { state: 'documented' | 'unknown'; source: 'npm' | 'man' | 'system_package' | 'homebrew' | 'path'; reference: string; scope?: 'command' | 'package' };
}
export interface CliCatalogEntry extends CliUsageMetadata {
  command: string;
  domains?: string[];
  helpArgs?: string[];
  examples?: { description: string; args: string[] }[];
  execution?: 'sandbox' | 'host';
  requirements?: string[];
  /** Missing usage means this path shares the entry's usage; only shadowed different tools need an override. */
  discovery?: { execution: 'host' | 'sandbox'; path: string; usage?: CliUsageMetadata }[];
}
export interface CliCatalogConfiguration { state: 'unconfigured' | 'empty' | 'configured'; entryCount: number; source?: 'automatic' | 'configured' }
export interface CliCatalogRecallMeta {
  recallTerms: string[];
  unregisteredNames: string[];
  queried: boolean;
  matches: Array<{ command: string; channels: CatalogRecallMatch['channels']; matchedTerms: string[] }>;
}
export interface CliCatalogPage {
  catalogVersion: string;
  entries: CliCatalogEntry[];
  nextCursor: string | null;
  configuration?: CliCatalogConfiguration;
  recall?: CliCatalogRecallMeta;
}
export class CliCatalogError extends Error { constructor(readonly code: string) { super(code); } }
const text = (value: unknown) => typeof value === 'string' && !!value.trim() && !value.includes('\0');
const args = (value: unknown) => Array.isArray(value) && value.length <= 128
  && value.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'));
const list = (value: unknown) => Array.isArray(value) && value.every(item => text(item));
const keys = new Set(['command', 'description', 'domains', 'helpArgs', 'examples', 'execution', 'requirements', 'scenarios', 'documentation', 'discovery']);
const documentation = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['state', 'source', 'reference', 'scope'].includes(key))
    && ['documented', 'unknown'].includes(String(item.state))
    && ['npm', 'man', 'system_package', 'homebrew', 'path'].includes(String(item.source)) && text(item.reference)
    && (item.scope === undefined || ['command', 'package'].includes(String(item.scope)));
};
const usage = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['description', 'scenarios', 'documentation'].includes(key)) && text(item.description)
    && (item.scenarios === undefined || list(item.scenarios)) && (item.documentation === undefined || documentation(item.documentation));
};
const discovery = (value: unknown) => Array.isArray(value) && new Set(value.map(item => item?.execution)).size === value.length
  && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).every(key => ['execution', 'path', 'usage'].includes(key))
    && ['host', 'sandbox'].includes(item.execution) && text(item.path) && (item.usage === undefined || usage(item.usage)));

/** Called only on trusted host configuration, never on model or skill output. Reject unknown fields to keep secrets out. */
export function parseCliCatalog(value: unknown): CliCatalogEntry[] {
  if (!Array.isArray(value)) throw new CliCatalogError('CLI_CATALOG_INVALID');
  const commands = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CliCatalogError('CLI_CATALOG_INVALID');
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !keys.has(key)) || typeof item.command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(item.command)
      || commands.has(item.command) || !text(item.description)
      || item.domains !== undefined && (!list(item.domains) || !(item.domains as string[]).every(domain => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)))
      || item.helpArgs !== undefined && !args(item.helpArgs)
      || item.requirements !== undefined && !list(item.requirements)
      || item.scenarios !== undefined && !list(item.scenarios)
      || item.documentation !== undefined && !documentation(item.documentation)
      || item.discovery !== undefined && !discovery(item.discovery)
      || item.execution !== undefined && item.execution !== 'sandbox' && item.execution !== 'host'
      || item.examples !== undefined && (!Array.isArray(item.examples) || !item.examples.every(example => example && typeof example === 'object'
        && !Array.isArray(example) && Object.keys(example).every(key => ['description', 'args'].includes(key)) && text(example.description) && args(example.args)))) {
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
  constructor(value?: unknown, source?: 'automatic' | 'configured') {
    this.entries = parseCliCatalog(value === undefined ? [] : value);
    this.configuration = { state: value === undefined ? 'unconfigured' : this.entries.length ? 'configured' : 'empty', entryCount: this.entries.length,
      ...(source ? { source } : {}) };
    this.catalogVersion = createHash('sha256').update(JSON.stringify(this.entries)).digest('hex');
  }
  /** Complete metadata for the shared decision snapshot; discovery pagination remains separate. */
  all(): CliCatalogPage {
    return { catalogVersion: this.catalogVersion, configuration: structuredClone(this.configuration),
      entries: structuredClone(this.entries), nextCursor: null };
  }
  recommend(objective: string) {
    const matches = recommendMetadata(this.entries, objective,
      entry => [entry.command, entry.description, ...(entry.scenarios ?? []), ...(entry.domains ?? []), ...(entry.requirements ?? [])].join(' '), entry => entry.command);
    return { catalogVersion: this.catalogVersion, configuration: structuredClone(this.configuration),
      matchState: matches.candidates.length ? 'matched' as const : 'no_match' as const, ...matches };
  }
  list({ query, cursor }: { query?: string; cursor?: string } = {}): CliCatalogPage {
    const q = normalizeCatalogQuery(query);
    const matches = this.entries.filter(entry => matchesCatalogQuery([entry.command, entry.description, ...(entry.scenarios ?? []), ...(entry.domains ?? []),
      ...(entry.requirements ?? [])].join(' '), q));
    const page = catalogWindow(matches, this.catalogVersion, q, cursor, () => new CliCatalogError('CLI_CATALOG_CURSOR_INVALID'));
    return { catalogVersion: this.catalogVersion, configuration: structuredClone(this.configuration), entries: structuredClone(page.entries), nextCursor: page.nextCursor };
  }
  recall({ query, terms, commands, cursor }: { query?: string; terms?: string[]; commands?: string[]; cursor?: string } = {}): CliCatalogPage {
    const q = normalizeCatalogQuery([query, ...(terms ?? [])].filter(Boolean).join(' '));
    const recalled = recallCatalogEntries(this.entries, {
      ...(query ? { query } : {}),
      ...(terms ? { terms } : {}),
      ...(commands ? { commands } : {}),
    });
    const entries = recalled.matches.map(match => match.entry);
    const page = catalogWindow(entries, this.catalogVersion, q, cursor, () => new CliCatalogError('CLI_CATALOG_CURSOR_INVALID'));
    return {
      catalogVersion: this.catalogVersion,
      configuration: structuredClone(this.configuration),
      entries: structuredClone(page.entries),
      nextCursor: page.nextCursor,
      recall: {
        recallTerms: recalled.recallTerms,
        unregisteredNames: recalled.unregisteredNames,
        queried: recalled.queried,
        matches: recalled.matches.map(match => ({ command: match.entry.command, channels: match.channels, matchedTerms: match.matchedTerms })),
      },
    };
  }
}
