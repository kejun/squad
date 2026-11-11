import type { Intent, MapPartitionRun, TaskContext } from '../types.js';
import { localEnabled, localPhysicalPending } from '../local-operation.js';
import { classifyCliFailure } from '../cli-failure.js';
import { acquisitionForOperation, resourceIdentity, sameResourceIdentity, savedAcquisitions, savedResourceAcquisitions, type HostAcquisition, type ResourceIdentity } from '../resource-acquisition.js';

export interface MapPrerequisiteFailure {
  key: string; kind: string; origin: string; configuration: string; observedAt: number;
  partitionIds: string[]; sourceIds: string[];
}
export interface MapSchedulingState {
  blockedPrerequisites: MapPrerequisiteFailure[];
  methodEvaluations: { partitionId: string; methodId: string }[];
}
export interface VerifiedReadMethod {
  id: string; sourceWorkId: string; sourceOperationId: string; sourceMember: string;
  configuration: string; resource: ResourceIdentity; acquisition: HostAcquisition;
  scope: { kind: 'resource'; resource: ResourceIdentity } | { kind: 'url_origin'; origin: string; catalogVersion: string; catalogOperationId: string };
  action: Extract<NonNullable<Intent['localOperations']>[number]['action'], { type: 'runCli' }> | { type: 'web_fetch'; url: string };
}

export const mapConfigurationKey = (c: TaskContext) => JSON.stringify([c.config.version, c.config.toolVersion]);

/** Only explicit resource identities are used; prose does not invent document or file identities. */
export function partitionResources(c: TaskContext, partitionId: string): ResourceIdentity[] {
  if (c.goal.partitionResources) {
    const mapped = c.goal.partitionResources[partitionId] ?? [];
    return mapped.flatMap(resource => resourceIdentity(resource) ?? []);
  }
  const part = c.discussion?.mapReduce?.partitions.find(item => item.id === partitionId);
  const urls = `${part?.objective ?? ''}\n${part?.expectedOutput ?? ''}`.match(/https?:\/\/[^\s<>"'`，。；、）)]+/g) ?? [];
  return [...new Set(urls)].flatMap(url => {
    try { return [{ kind: 'url' as const, url: new URL(url).href }]; } catch { return []; }
  });
}

function resourceDomain(resource: ResourceIdentity): string {
  if (resource.kind === 'url') return new URL(resource.url).origin;
  if (resource.kind === 'document') return JSON.stringify(['document', resource.service, resource.namespace]);
  return JSON.stringify(['file', resource.workspaceId]);
}

function partitionOrigins(c: TaskContext, partitionId: string): string[] {
  return partitionResources(c, partitionId).map(resourceDomain);
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function verifiedMethodScope(c: TaskContext, resource: ResourceIdentity, action: VerifiedReadMethod['action'], at = Infinity): VerifiedReadMethod['scope'] {
  if (resource.kind !== 'url' || action.type !== 'runCli') return { kind: 'resource', resource };
  const source = new URL(resource.url);
  const catalogOperations = c.intents.filter(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion)
    .flatMap(work => work.localOperations ?? []).filter(operation => operation.action.type === 'discoverHost'
      && operation.status === 'succeeded' && operation.result?.ok && (operation.finishedAt ?? Infinity) <= at)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
  for (const operation of catalogOperations) {
    const catalog = asRecord(asRecord(operation.result!.data.cli).catalog);
    if (typeof catalog.catalogVersion !== 'string' || !Array.isArray(catalog.entries)) continue;
    const entry = catalog.entries.map(asRecord).find(item => item.command === action.executable
      && (item.execution ?? 'sandbox') === (action.execution ?? 'sandbox')
      && Array.isArray(item.domains) && item.domains.includes(source.hostname));
    if (entry) return { kind: 'url_origin', origin: source.origin, catalogVersion: catalog.catalogVersion, catalogOperationId: operation.id };
  }
  return { kind: 'resource', resource };
}

function methodIdentity(c: TaskContext, acquisition: HostAcquisition, action: VerifiedReadMethod['action'], scope: VerifiedReadMethod['scope']): string {
  const resourceText = acquisition.resource.kind === 'url' ? acquisition.resource.url : '';
  const invocation = action.type === 'runCli'
    ? [action.executable, action.args.map(arg => resourceText ? arg.split(resourceText).join('<resource>') : arg),
      action.cwd ?? '.', action.execution ?? 'sandbox', action.skillId ?? null]
    : ['web_fetch'];
  const applicable = scope.kind === 'url_origin' ? [scope.kind, scope.origin, scope.catalogVersion] : [scope.kind, scope.resource];
  return JSON.stringify([mapConfigurationKey(c), acquisition.verifier, invocation, applicable]);
}

/** The successful source is checked against its immutable host receipt on every projection. */
export function verifiedReadMethods(c: TaskContext): VerifiedReadMethod[] {
  if (c.stopped || c.outcome !== null) return [];
  const methods = savedResourceAcquisitions(c).flatMap(acquisition => {
    const work = c.intents.find(item => item.id === acquisition.workId);
    if (!work || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion || !acquisition.verifier
      || acquisition.configuration?.id !== 'task-protocol' || acquisition.configuration.version !== mapConfigurationKey(c)
      || acquisition.configuration.authentication !== 'satisfied') return [];
    const operation = work.localOperations?.find(item => item.id === acquisition.operationId);
    const action = operation?.action.type === 'runCli' ? structuredClone(operation.action)
      : acquisition.source === 'webFetch' && acquisition.resource.kind === 'url'
        ? { type: 'web_fetch' as const, url: acquisition.resource.url } : undefined;
    if (!action) return [];
    const fault = c.intents.filter(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion)
      .flatMap(source => workFailureFacts(c, source)).filter(failure => failure.origin === resourceDomain(acquisition.resource))
      .sort((left, right) => right.at - left.at)[0];
    if (fault && fault.at >= acquisition.at) return [];
    const scope = verifiedMethodScope(c, acquisition.resource, action, acquisition.at);
    const currentScope = verifiedMethodScope(c, acquisition.resource, action);
    if (scope.kind === 'url_origin' && (currentScope.kind !== 'url_origin' || currentScope.catalogVersion !== scope.catalogVersion)) return [];
    return [{ id: `${methodIdentity(c, acquisition, action, scope)}:generation:${fault?.sourceId ?? 'initial'}`,
      sourceWorkId: work.id, sourceOperationId: acquisition.operationId, sourceMember: work.target,
      configuration: acquisition.configuration.version, resource: acquisition.resource, acquisition, action, scope }];
  });
  return [...new Map(methods.sort((left, right) => left.acquisition.at - right.acquisition.at).map(method => [method.id, method])).values()];
}

export function methodAppliesToPartition(c: TaskContext, method: VerifiedReadMethod, partitionId: string): boolean {
  return method.configuration === mapConfigurationKey(c)
    && partitionResources(c, partitionId).some(resource => method.scope.kind === 'resource'
      ? sameResourceIdentity(resource, method.scope.resource) : resource.kind === 'url' && new URL(resource.url).origin === method.scope.origin);
}

function workFailureFacts(c: TaskContext, work: Intent) {
  const partitionId = (work.payload.partition as { id?: string } | undefined)?.id;
  const assigned = partitionId ? partitionResources(c, partitionId) : [];
  const local = (work.localOperations ?? []).flatMap(operation => {
    const observed = acquisitionForOperation(c, work, operation);
    const kind = observed?.status === 'authentication_required' ? 'authentication' : classifyCliFailure(operation);
    if (!kind || kind === 'unknown' || operation.action.type !== 'runCli') return [];
    const action = operation.action;
    const explicit = action.args.flatMap(arg => resourceIdentity({ kind: 'url', url: arg }) ?? []);
    const resources = observed ? [observed.requestedResource] : explicit.length ? explicit : assigned;
    return [...new Set(resources.map(resourceDomain))].map(origin => ({ sourceId: operation.id,
      at: observed?.at ?? operation.finishedAt ?? operation.createdAt, kind, origin, configuration: mapConfigurationKey(c),
      key: JSON.stringify([kind, origin, action.executable, action.execution ?? 'sandbox',
        action.cwd ?? '.', action.skillId ?? null, mapConfigurationKey(c)]) }));
  });
  const web = (work.toolRecovery?.failures ?? []).filter(failure => failure.code === 'WEB_TOOL_CONFIGURATION_UNAVAILABLE')
    .flatMap(failure => [...new Set(assigned.map(resourceDomain))].map(origin => ({ sourceId: failure.requestId,
      at: failure.at ?? c.trace.find(entry => entry.event === 'RECORD_TOOL_FAILURE' && entry.detail.includes(failure.requestId))?.at ?? 0,
      kind: 'web_configuration', origin, configuration: mapConfigurationKey(c),
      key: JSON.stringify(['web_configuration', failure.tool, origin, mapConfigurationKey(c)]) })));
  const webAuthentication = savedAcquisitions(c).filter(receipt => receipt.source === 'webFetch' && receipt.workId === work.id
    && receipt.epoch === c.epoch && receipt.goalVersion === c.goalVersion && receipt.status === 'authentication_required'
    && receipt.verifier && receipt.requestedResource.kind === 'url' && receipt.configuration?.id === 'task-protocol'
    && receipt.configuration.version === mapConfigurationKey(c)).map(receipt => {
    const origin = resourceDomain(receipt.requestedResource);
    return { sourceId: receipt.operationId, at: receipt.at, kind: 'web_authentication', origin,
      configuration: receipt.configuration!.version, key: JSON.stringify(['web_authentication', 'web_fetch', origin, receipt.configuration!.version]) };
  });
  return [...local, ...web, ...webAuthentication];
}

function failureFacts(c: TaskContext) {
  return (c.discussion?.results ?? []).filter(result => result.partitionId && result.workId && ['failed', 'partial', 'timeout'].includes(result.status))
    .flatMap(result => {
      const work = c.intents.find(item => item.id === result.workId);
      if (!work || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion || localPhysicalPending(work)) return [];
      return workFailureFacts(c, work).map(fact => ({ ...fact, partitionId: result.partitionId! }));
    });
}

/** Common means separate partitions with matching trusted diagnostics, never matching model prose. */
export function sharedPrerequisiteFailures(c: TaskContext): MapPrerequisiteFailure[] {
  const facts = failureFacts(c), keys = [...new Set(facts.map(fact => fact.key))];
  return keys.flatMap(key => {
    const group = facts.filter(fact => fact.key === key), partitionIds = [...new Set(group.map(fact => fact.partitionId))];
    if (partitionIds.length < 2) return [];
    const first = group[0]!;
    return [{ key, kind: first.kind, origin: first.origin, configuration: first.configuration, observedAt: Math.max(...group.map(fact => fact.at)),
      partitionIds, sourceIds: [...new Set(group.map(fact => fact.sourceId))] }];
  });
}

export function partitionPrerequisiteBlocked(c: TaskContext, part: MapPartitionRun): boolean {
  const origins = partitionOrigins(c, part.partitionId);
  return sharedPrerequisiteFailures(c).some(failure => origins.includes(failure.origin));
}

export function newPartitionMethod(c: TaskContext, part: MapPartitionRun, target?: string): VerifiedReadMethod | undefined {
  const used = c.discussion?.mapReduce?.scheduling?.methodEvaluations ?? [];
  return verifiedReadMethods(c).find(method => methodAppliesToPartition(c, method, part.partitionId)
    && (method.action.type === 'runCli' ? c.config.localTools?.enabled !== false && (!target || localEnabled(c.config, target)) : c.config.webTools?.enabled !== false)
    && !used.some(evaluation => evaluation.partitionId === part.partitionId && evaluation.methodId === method.id));
}

export function partitionMayDispatch(c: TaskContext, part: MapPartitionRun, target?: string): boolean {
  const requiresMethod = partitionPrerequisiteBlocked(c, part) || part.reason === 'VERIFIED_METHOD_AVAILABLE';
  return !requiresMethod || !!newPartitionMethod(c, part, target);
}

export function schedulingState(c: TaskContext): MapSchedulingState {
  const plan = c.discussion!.mapReduce!;
  return plan.scheduling ??= { blockedPrerequisites: [], methodEvaluations: [] };
}

export function consumePartitionMethod(c: TaskContext, part: MapPartitionRun, target?: string): VerifiedReadMethod | undefined {
  const method = newPartitionMethod(c, part, target);
  if (method) schedulingState(c).methodEvaluations.push({ partitionId: part.partitionId, methodId: method.id });
  return method;
}
