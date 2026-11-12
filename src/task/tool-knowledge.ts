import { localEnabled, type Intent, type TaskContext } from '../types.js';
import type { LocalOperation } from '../local-operation.js';
import { partitionResources, verifiedReadMethods, type VerifiedReadMethod } from './map-scheduling.js';
import { sameResourceIdentity } from '../resource-acquisition.js';
import type { ToolInventorySnapshot } from '../tool-inventory.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(record(value), key))
  .map(key => [key, structuredClone(record(value)[key])]));
const entries = (value: unknown, keys: string[]) => Array.isArray(value) ? value.map(item => pick(item, keys)) : [];
function skillMetadata(value: unknown) {
  const data = record(value);
  return { ...pick(data, ['catalogVersion', 'complete', 'nextCursor']),
    skills: entries(data.skills, ['skillId', 'skillVersion', 'name', 'description', 'source', 'compatibility']),
    diagnostics: entries(data.diagnostics, ['source', 'code']) };
}
function capabilityMetadata(data: Record<string, unknown>) {
  const cli = record(data.cli), catalog = record(cli.catalog);
  return { ...pick(data, ['platform', 'arch']), runtime: pick(data.runtime, ['name', 'version']),
    skills: skillMetadata(data.skills), cli: { ...pick(cli, ['queriedOnly', 'hostApprovalRequired', 'presenceIsNotExecution', 'network']),
      sandbox: pick(cli.sandbox, ['available', 'reason']), commands: entries(cli.commands, ['command', 'sandbox', 'host']),
      catalog: { ...pick(catalog, ['catalogVersion', 'nextCursor']),
        entries: entries(catalog.entries, ['command', 'description', 'scenarios', 'documentation', 'domains', 'helpArgs', 'examples', 'execution', 'requirements']) } },
    mcp: pick(data.mcp, ['status', 'scope', 'reason']) };
}
export function settledToolObservation(operation: LocalOperation): { observation?: Record<string, unknown>; metadataComplete?: boolean } | null {
  const action = operation.action, result = operation.result;
  if (!result) return null;
  if (action.type === 'runCli') {
    return operation.status === 'failed' && !result.ok && result.code === 'CLI_SANDBOX_UNAVAILABLE' && action.execution !== 'host'
      ? { observation: { sandbox: { available: false }, code: result.code } } : null;
  }
  if (!['discoverHost', 'listSkills'].includes(action.type) || operation.status !== 'succeeded' || !result.ok) return null;
  const metadata = action.type === 'listSkills' ? { skills: skillMetadata(result.data) } : capabilityMetadata(result.data);
  return { observation: metadata, metadataComplete: true };
}

/** The full current catalog is injected once; repeated observations refer to its immutable versions. */
export function referenceToolObservation(metadata: Record<string, unknown>, inventory: ToolInventorySnapshot) {
  const observation = structuredClone(metadata), cli = record(observation.cli), catalog = record(cli.catalog), skills = record(observation.skills);
  const cliCatalogVersion = typeof catalog.catalogVersion === 'string' ? catalog.catalogVersion : undefined;
  const skillCatalogVersion = typeof skills.catalogVersion === 'string' ? skills.catalogVersion : undefined;
  const metadataReference = {
    ...(cliCatalogVersion ? { cliCatalogVersion, cliMatchesCurrent: cliCatalogVersion === inventory.cli.catalogVersion } : {}),
    ...(skillCatalogVersion ? { skillCatalogVersion, skillsMatchCurrent: skillCatalogVersion === inventory.skills.catalogVersion } : {}),
  };
  delete catalog.entries; delete skills.skills;
  return { observation, metadataReference, metadataComplete: (cliCatalogVersion === undefined || cliCatalogVersion === inventory.cli.catalogVersion)
    && (skillCatalogVersion === undefined || skillCatalogVersion === inventory.skills.catalogVersion) };
}

function methodForWork(c: TaskContext, method: VerifiedReadMethod, work: Intent): boolean {
  const partition = work.payload.partition as { id?: string; objective?: string; expectedOutput?: string } | undefined;
  if (partition?.id && c.goal.partitionResources) return partitionResources(c, partition.id).some(resource =>
    method.scope.kind === 'resource' ? sameResourceIdentity(resource, method.scope.resource)
      : resource.kind === 'url' && new URL(resource.url).origin === method.scope.origin);
  const goal = work.payload.goal as { text?: string } | undefined;
  const assignment = partition ? `${partition.objective ?? ''}\n${partition.expectedOutput ?? ''}`
    : `${work.payload.question ?? ''}\n${work.payload.expected ?? ''}\n${goal?.text ?? ''}`;
  return (assignment.match(/https?:\/\/[^\s<>"'`，。；、）)]+/g) ?? []).some(url => {
    try { return method.scope.kind === 'resource'
      ? sameResourceIdentity({ kind: 'url', url: new URL(url).href }, method.scope.resource)
      : new URL(url).origin === method.scope.origin; } catch { return false; }
  });
}

/** Read methods are observations, never evidence for another resource or execution authority. */
export function sharedToolKnowledge(c: TaskContext, work: Intent, inventory?: ToolInventorySnapshot) {
  if (c.stopped || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion
    || !['owner', 'assistance', 'facilitator'].includes(work.kind)
    || !localEnabled(c.config, work.target)
    || (work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools !== true) return [];
  const observations = c.intents.filter(source => source.id !== work.id && source.epoch === c.epoch && source.goalVersion === c.goalVersion)
    .flatMap(source => (source.localOperations ?? []).flatMap(operation => {
      const action = operation.action;
      const fact = settledToolObservation(operation);
      if (!fact) return [];
      return [{ sourceOperationId: operation.id, sourceMember: source.target, finishedAt: operation.finishedAt ?? null,
        action: structuredClone(action), ...fact,
        ...(inventory && fact.observation ? referenceToolObservation(fact.observation, inventory) : {}),
        observationOnly: true, requiresIndependentExecution: true }];
    }));
  const methods = verifiedReadMethods(c).filter(method => method.sourceWorkId !== work.id && methodForWork(c, method, work))
    .map(method => ({ sourceOperationId: method.sourceOperationId, sourceMember: method.sourceMember,
      finishedAt: method.acquisition.at, action: structuredClone(method.action), methodId: method.id,
      resourceScope: structuredClone(method.scope), configuration: method.configuration,
      validation: { status: 'acquired' as const, resource: method.resource, verifier: method.acquisition.verifier },
      observationOnly: true as const, requiresIndependentExecution: true as const }));
  return [...observations, ...methods];
}
