import type { LocalRuntime } from './local-runtime.js';
import type { Intent, TaskContext } from './types.js';
import { classifyCliFailure } from './cli-failure.js';
import { acquisitionForOperation } from './resource-acquisition.js';
import { parseCliCatalog, type CliCatalogEntry } from './cli-catalog.js';
import { cliEntryVersion, type ToolInventorySnapshot } from './tool-inventory.js';

export interface CliReadiness {
  installation: 'unknown' | 'found' | 'not_found';
  authentication: 'unknown' | 'required' | 'satisfied';
  authorization: 'unknown' | 'required' | 'denied';
  authorizationScope: 'execution' | 'registered_invocation';
  network: 'unknown';
  observedAt: number | null;
  sourceOperationIds: string[];
  inventoryObservation?: { catalogVersion: string; observedAt: number; path?: string };
}
type Recommendations = ReturnType<LocalRuntime['recommendTools']>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function savedEntryVersions(entries: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    try { const parsed = parseCliCatalog([entry])[0]!; result.set(parsed.command, cliEntryVersion(parsed)); }
    catch { /* Invalid historical metadata cannot establish a current entry's identity. */ }
  }
  return result;
}
function readinessSources(c: TaskContext) {
  return c.intents.filter(work => work.epoch === c.epoch && work.goalVersion === c.goalVersion)
    .flatMap(work => (work.localOperations ?? []).map(operation => ({ work, operation })))
    .filter(({ operation }) => operation.result && ['succeeded', 'failed'].includes(operation.status))
    .sort((a, b) => (a.operation.finishedAt ?? 0) - (b.operation.finishedAt ?? 0))
    .map(source => {
      const { operation } = source;
      if (operation.action.type !== 'discoverHost' || !operation.result?.ok || operation.status !== 'succeeded') return { ...source, discovery: undefined };
      const cli = record(operation.result.data.cli), catalog = record(cli.catalog);
      const commands = Array.isArray(cli.commands) ? cli.commands.map(record) : [];
      return { ...source, discovery: { catalogVersion: catalog.catalogVersion, entryVersions: savedEntryVersions(catalog.entries),
        commands: new Map(commands.map(command => [command.command, command])) } };
    });
}
function readiness(c: TaskContext, target: Intent, candidate: CliCatalogEntry, catalogVersion: string,
  execution: 'sandbox' | 'host', sources: ReturnType<typeof readinessSources>, entryVersion = cliEntryVersion(candidate), snapshot?: ToolInventorySnapshot): CliReadiness {
  const automatic = snapshot?.cli.configuration.source === 'automatic';
  const discovered = candidate.discovery?.find(entry => entry.execution === execution);
  const state: CliReadiness = { installation: 'unknown', authentication: 'unknown',
    authorization: execution === 'host' ? 'required' : 'unknown', authorizationScope: 'execution',
    network: 'unknown', observedAt: null, sourceOperationIds: [] };
  if (automatic) {
    state.installation = discovered ? 'found' : 'not_found'; state.observedAt = snapshot.observedAt;
    state.inventoryObservation = { catalogVersion: snapshot.cli.catalogVersion, observedAt: snapshot.observedAt,
      ...(discovered ? { path: discovered.path } : {}) };
  }
  for (const { work, operation, discovery } of sources) {
    if (!operation.result) continue;
    let observed = false;
    const installationCurrent = !state.inventoryObservation || operation.finishedAt !== undefined
      && operation.finishedAt >= state.inventoryObservation.observedAt;
    if (installationCurrent && discovery && (discovery.catalogVersion === catalogVersion || discovery.entryVersions.get(candidate.command) === entryVersion)) {
      const command = discovery.commands.get(candidate.command);
      if (command && ['found', 'not_found'].includes(String(command[execution]))) {
        state.installation = command[execution] as 'found' | 'not_found'; observed = true;
      }
    }
    if (operation.action.type === 'runCli' && operation.action.executable === candidate.command
      && (operation.action.execution ?? 'sandbox') === execution) {
      if (installationCurrent && operation.result.code === 'CLI_NOT_FOUND') { state.installation = 'not_found'; observed = true; }
      else if (installationCurrent && typeof operation.result.data.exitCode === 'number') { state.installation = 'found'; observed = true; }
      const registered = work.id === target.id && (operation.action.cwd ?? '.') === '.' && operation.action.stdin === undefined
        && [candidate.helpArgs, ...(candidate.examples ?? []).map(example => example.args)]
          .some(args => args && JSON.stringify(args) === JSON.stringify(operation.action.type === 'runCli' ? operation.action.args : []));
      if (registered && classifyCliFailure(operation) === 'authentication') { state.authentication = 'required'; observed = true; }
      const acquisition = acquisitionForOperation(c, work, operation);
      if (registered && acquisition?.configuration?.version === JSON.stringify([c.config.version, c.config.toolVersion])
        && acquisition.configuration.authentication !== 'unknown') {
        state.authentication = acquisition.configuration.authentication; observed = true;
      }
      if (registered && operation.approval?.status === 'denied') {
        state.authorization = 'denied'; state.authorizationScope = 'registered_invocation'; observed = true;
      }
    }
    if (observed) {
      if (!state.sourceOperationIds.includes(operation.id)) state.sourceOperationIds.push(operation.id);
      if (operation.finishedAt !== undefined) state.observedAt = Math.max(state.observedAt ?? operation.finishedAt, operation.finishedAt);
    }
  }
  return state;
}

/** Complete registered metadata with per-environment observations; no ranking, probing or filtering. */
export function withToolInventoryReadiness(c: TaskContext, work: Intent, snapshot: ToolInventorySnapshot) {
  const sources = readinessSources(c);
  return { ...snapshot, cli: { ...snapshot.cli, entries: snapshot.cli.entries.map(entry => {
    const entryVersion = cliEntryVersion(entry);
    return { ...entry, toolId: `cli:${entry.command}`, entryVersion,
    variants: (['sandbox', 'host'] as const).map(execution => ({ execution, approvalRequired: execution === 'host',
      readiness: readiness(c, work, entry, snapshot.cli.catalogVersion, execution, sources, entryVersion, snapshot) })),
  }; }) } };
}

export type ToolInventoryView = ReturnType<typeof withToolInventoryReadiness>;

/** Project settled host facts only. Metadata matching never probes programs or reads credentials. */
export function withCliReadiness(c: TaskContext, work: Intent, recommendations: Recommendations) {
  const sources = readinessSources(c);
  const entries = recommendations.cli.candidates.map(candidate => ({ ...candidate,
    readiness: readiness(c, work, candidate, recommendations.cli.catalogVersion, candidate.execution ?? 'sandbox', sources) }));
  const unavailable = (entry: typeof entries[number]) => entry.readiness.installation === 'not_found'
    || entry.readiness.authentication === 'required' || entry.readiness.authorization === 'denied';
  return { ...recommendations, cli: { ...recommendations.cli,
    candidates: entries.filter(entry => !unavailable(entry)), unavailableCandidates: entries.filter(unavailable),
    executionAuthority: false as const, currentWorkId: work.id } };
}
