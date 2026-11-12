import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CliCatalog, type CliCatalogEntry, type CliCatalogConfiguration } from './cli-catalog.js';
import { discoverCliCatalog, type CliDiscoveryOptions } from './automatic-cli-catalog.js';
import { LocalToolError, SkillRegistry, type RegistryOptions, type SkillPage } from './local-skills.js';

export interface ToolInventorySnapshot {
  schemaVersion: 1;
  catalogVersion: string;
  observedAt: number;
  metadataOnly: true;
  executionAuthority: false;
  environment: {
    platform: string; arch: string;
    sandbox: { available: boolean; reason?: string };
    host: { approvalRequired: true };
  };
  cli: { catalogVersion: string; configuration: CliCatalogConfiguration; entries: CliCatalogEntry[] };
  skills: Pick<SkillPage, 'catalogVersion' | 'complete' | 'skills' | 'diagnostics'>;
  refresh: { status: 'current' | 'failed'; checkedAt: number; error?: string };
}
export interface ToolInventoryOptions {
  dataRoot: string;
  skillRoots?: string[];
  cliCatalog?: CliCatalogEntry[];
  cliCatalogFile?: string;
  cliDiscovery?: CliDiscoveryOptions;
  commandEnv?: Record<string, Record<string, string>>;
  catalogRefreshIntervalMs?: number;
  registryLimits?: Omit<RegistryOptions, 'roots' | 'snapshotRoot'>;
  clock?: () => number;
}
interface SandboxObservation { available: boolean; unavailableReason?: string | undefined }
interface InventoryGeneration { cli: CliCatalog; registry: SkillRegistry; snapshot: ToolInventorySnapshot }
const partialScanDiagnostics = new Set(['SKILLS_SCAN_LIMIT', 'SKILL_PACKAGE_LIMIT', 'SKILL_BINDING_INVALID', 'SKILL_BINDINGS_UNREADABLE']);
const refreshFailureCodes = new Set(['CLI_CATALOG_INVALID', 'CLI_CATALOG_UNAVAILABLE', 'SKILLS_ROOT_MISSING',
  'SKILLS_ROOT_UNREADABLE', 'SKILL_METADATA_INVALID', 'SKILL_VERSION_CHANGED', 'SKILL_UNREADABLE',
  'SKILL_PATH_ESCAPE', 'SKILL_LINK_CYCLE', 'SKILL_SPECIAL_FILE']);

const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Only declared metadata identifies a CLI entry; projections never change its identity. */
export function cliEntryVersion(entry: CliCatalogEntry): string {
  return hash(entry);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** One owner publishes complete generations; model decisions only read the published value. */
export class ToolInventoryStore {
  private generation: InventoryGeneration | undefined;
  private refreshJob: Promise<ToolInventorySnapshot> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private watchers: FSWatcher[] = [];
  private changedDuringRefresh = false;
  private closed = false;
  private readonly interval: number;
  constructor(private readonly options: ToolInventoryOptions, private readonly sandbox: SandboxObservation) {
    this.interval = options.catalogRefreshIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 0 || this.interval > 2_147_483_647)
      throw new LocalToolError('TOOL_INVENTORY_INTERVAL_INVALID');
  }
  private get current(): InventoryGeneration {
    if (!this.generation) throw new LocalToolError('LOCAL_RUNTIME_NOT_READY');
    return this.generation;
  }
  get cliCatalog(): CliCatalog { return this.current.cli; }
  get registry(): SkillRegistry { return this.current.registry; }
  snapshot(): ToolInventorySnapshot { return this.current.snapshot; }
  async initialize(): Promise<void> {
    await this.refresh();
    if (!this.closed && this.interval > 0) this.startWatching();
  }
  refresh(): Promise<ToolInventorySnapshot> {
    if (this.closed) return Promise.reject(new LocalToolError('LOCAL_RUNTIME_CLOSED'));
    if (this.refreshJob) return this.refreshJob;
    this.refreshJob = this.build().catch(error => {
      if (!this.generation) throw error;
      if (!this.closed) this.generation = { ...this.generation,
        snapshot: freeze({ ...this.generation.snapshot, refresh: { status: 'failed' as const,
          checkedAt: this.now(), error: error instanceof LocalToolError && refreshFailureCodes.has(error.code)
            ? error.code : 'TOOL_INVENTORY_REFRESH_FAILED' } }) };
      return this.current.snapshot;
    }).finally(() => {
      this.refreshJob = undefined;
      if (this.changedDuringRefresh && !this.closed) { this.changedDuringRefresh = false; this.scheduleRefresh(); }
    });
    return this.refreshJob;
  }
  private now(): number { return (this.options.clock ?? Date.now)(); }
  private async readCatalog(): Promise<CliCatalog> {
    if (!this.options.cliCatalogFile) return this.options.cliCatalog === undefined
      ? new CliCatalog(await discoverCliCatalog(this.options.cliDiscovery, this.options.commandEnv), 'automatic')
      : new CliCatalog(this.options.cliCatalog, 'configured');
    let text: string;
    try { text = await readFile(this.options.cliCatalogFile, 'utf8'); }
    catch { throw new LocalToolError('CLI_CATALOG_UNAVAILABLE'); }
    try {
      return new CliCatalog(JSON.parse(text), 'configured');
    } catch { throw new LocalToolError('CLI_CATALOG_INVALID'); }
  }
  private async build(): Promise<ToolInventorySnapshot> {
    const cli = await this.readCatalog();
    const registry = await SkillRegistry.discover({ ...this.options.registryLimits,
      ...(this.options.skillRoots ? { roots: this.options.skillRoots } : {}), snapshotRoot: join(this.options.dataRoot, 'skills') });
    // A deliberate directory deletion scans cleanly. An unreadable or invalid source
    // must not erase a previously valid generation under the appearance of success.
    const failedSource = registry.diagnostics.find(diagnostic => !partialScanDiagnostics.has(diagnostic.code));
    if (this.generation && failedSource) throw new LocalToolError(failedSource.code);
    if (this.generation) registry.retainPrevious(this.generation.registry);
    const cliPage = cli.all(), skillPage = registry.all();
    const skillComplete = skillPage.complete;
    const environment: ToolInventorySnapshot['environment'] = { platform: process.platform, arch: process.arch,
      sandbox: { available: this.sandbox.available,
        ...(this.sandbox.unavailableReason ? { reason: this.sandbox.unavailableReason } : {}) }, host: { approvalRequired: true } };
    const snapshot = freeze<ToolInventorySnapshot>({ schemaVersion: 1, metadataOnly: true, executionAuthority: false,
      catalogVersion: hash([cliPage.catalogVersion, cliPage.configuration, skillPage.catalogVersion, environment, skillComplete, skillPage.diagnostics]),
      observedAt: this.now(), environment,
      cli: { catalogVersion: cliPage.catalogVersion, configuration: structuredClone(cli.configuration), entries: cliPage.entries },
      skills: { catalogVersion: skillPage.catalogVersion, complete: skillComplete, skills: skillPage.skills, diagnostics: skillPage.diagnostics },
      refresh: { status: 'current', checkedAt: this.now() } });
    if (this.closed) return this.generation?.snapshot ?? snapshot;
    this.generation = { cli, registry, snapshot };
    return snapshot;
  }
  private scheduleRefresh(): void {
    if (this.closed) return;
    if (this.refreshJob) { this.changedDuringRefresh = true; return; }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh().catch(() => {});
    }, 100);
    this.debounce.unref();
  }
  private observe(path: string, recursive: boolean, file?: string): void {
    try {
      const watcher = watch(path, { recursive }, (_event, name) => {
        if (!file || name === null || String(name) === file) this.scheduleRefresh();
      });
      watcher.on('error', () => { watcher.close(); this.watchers = this.watchers.filter(item => item !== watcher); });
      watcher.unref(); this.watchers.push(watcher);
    } catch { /* Periodic refresh also covers missing roots and unsupported native watching. */ }
  }
  private startWatching(): void {
    if (this.options.cliCatalog === undefined && !this.options.cliCatalogFile)
      for (const path of this.options.cliDiscovery?.paths ?? (process.env.PATH ?? '').split(':').filter(Boolean)) this.observe(path, false);
    if (this.options.cliCatalogFile) {
      const file = resolve(this.options.cliCatalogFile);
      this.observe(dirname(file), false, basename(file));
    }
    for (const root of this.options.skillRoots ?? [join(homedir(), '.agents', 'skills')]) this.observe(root, true);
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.interval);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.refreshJob;
  }
}
