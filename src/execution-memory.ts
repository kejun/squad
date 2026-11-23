import { createHash } from 'node:crypto';
import { pinnedSource, requiredResources, sameResourceIdentity, savedAcquisitions, verifiedResourceAcquisition,
  type HostAcquisition, type ResourceRequirement } from './resource-acquisition.js';
import { partitionContract, resourceInReadingScope, routeObservation, type LearnedReadRoute, type ReadFailureObservation,
  type ReadRefutation, type ReusablePartition,
  type TaskExecutionMemory } from './task/execution-memory.js';
import { mapConfigurationKey, partitionResources } from './task/map-scheduling.js';
import type { TaskContext, TeamConfig } from './types.js';
import type { ToolInventorySnapshot } from './tool-inventory.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

interface CollectionGap {
  kind: 'route' | 'partition';
  id: string;
  reason: string;
}

export interface MemoryCollection {
  revision: string;
  observations: number;
  routes: number;
  partitions: number;
  gaps: CollectionGap[];
}

export interface RoomExecutionMemory {
  pending: Record<string, string>;
  processed: Record<string, string>;
  routes: LearnedReadRoute[];
  partitions: ReusablePartition[];
  observations?: ReadFailureObservation[];
  collections?: Record<string, MemoryCollection>;
}

function memoryCheckpoint(c: TaskContext): { key: string; publishedAt?: number } | undefined {
  if (!c.config.executionMemory || c.config.deliveryReport !== 'summary') return undefined;
  const publication = c.publishedDelivery;
  if (c.outcome === 'complete' && publication?.revision && publication.goalVersion === c.goalVersion)
    return { key: publication.revision, publishedAt: publication.at };
  if (c.stopped || c.outcome !== null) {
    const tried = c.intents.some(work => work.learnedReadRoute && work.epoch === c.epoch && work.goalVersion === c.goalVersion);
    if (tried) return { key: `feedback:${c.epoch}:${c.goalVersion}` };
  }
  return undefined;
}

export function rememberFinishedExecution(memory: RoomExecutionMemory | undefined, c: TaskContext): RoomExecutionMemory | undefined {
  const checkpoint = memoryCheckpoint(c);
  if (!checkpoint) return memory;
  memory ??= { pending: {}, processed: {}, routes: [], partitions: [] };
  if (memory.processed[c.taskId] !== checkpoint.key) memory.pending[c.taskId] = checkpoint.key;
  return memory;
}

function learnObservations(c: TaskContext, receipts: readonly HostAcquisition[]): ReadFailureObservation[] {
  return receipts.flatMap((receipt): ReadFailureObservation[] => {
    const evidence = { id: receipt.id, sourceTaskId: c.taskId, operationId: receipt.operationId,
      resource: receipt.requestedResource, at: receipt.at };
    if (receipt.source === 'webFetch' && receipt.status === 'authentication_required' && receipt.verifier)
      return [{ ...evidence, kind: 'web_login', ...(receipt.protectedPrefix ? { protectedPrefix: receipt.protectedPrefix } : {}) }];
    const operation = c.intents.find(work => work.id === receipt.workId)?.localOperations?.find(op => op.id === receipt.operationId);
    const pattern = receipt.readingPattern;
    if (operation?.result?.data.sandboxReadFailure === true)
      return [{ ...evidence, kind: 'sandbox_ps', ...(pattern?.execution === 'sandbox'
        && resourceInReadingScope(receipt.requestedResource, pattern.urlPrefix) ? { pattern } : {}) }];
    return [];
  });
}

function learnRoutes(memory: RoomExecutionMemory, c: TaskContext, receipts: readonly HostAcquisition[], gaps: CollectionGap[]): number {
  const configuration = mapConfigurationKey(c);
  const sources = requiredResources(c);
  const learned = new Set<string>();
  for (const success of receipts.filter(item => item.source === 'runCli')) {
    const { resource, verifier, readingPattern } = success;
    if (!verifiedResourceAcquisition(success)) {
      gaps.push({ kind: 'route', id: success.id, reason: success.status });
      continue;
    }
    const work = c.intents.find(item => item.id === success.workId);
    const action = work?.localOperations?.find(item => item.id === success.operationId)?.action;
    if (resource.kind !== 'url' || !verifier || action?.type !== 'runCli'
      || !sources.some(item => sameResourceIdentity(item.resource, resource))) {
      gaps.push({ kind: 'route', id: success.id, reason: 'source-unbound' });
      continue;
    }
    const pattern = readingPattern && resourceInReadingScope(resource, readingPattern.urlPrefix) ? readingPattern : undefined;
    if (!pattern?.accountKnown) gaps.push({ kind: 'route', id: success.id, reason: 'reading-scope-unverified' });
    const execution = action.execution ?? 'sandbox', origin = new URL(resource.url).origin;
    const routeKey = [configuration, action.executable, execution, verifier.id, verifier.version];
    const baseId = digest(JSON.stringify([...routeKey, pattern?.accountKnown ? pattern.binding : resource]));
    const broad = memory.routes.find(route => route.id === baseId);
    const restoreOnlyDocument = broad?.disabled === true;
    const id = restoreOnlyDocument ? digest(JSON.stringify([baseId, resource])) : baseId;
    const previous = restoreOnlyDocument ? memory.routes.find(route => route.id === id) : broad;
    const restriction = previous?.exceptions?.find(item => sameResourceIdentity(item.resource, resource));
    const invalidation = previous?.invalidatedBy ?? restriction ?? (restoreOnlyDocument ? broad.invalidatedBy : undefined);
    if (work?.learnedReadRoute || invalidation && success.at <= invalidation.at) continue;
    if (previous && success.at <= previous.observedAt && !restriction) continue;

    const route: LearnedReadRoute = { id, origin, configuration, executable: action.executable, execution, verifier, resource,
      version: previous ? previous.version + Number(!!restriction || previous.disabled) : (restoreOnlyDocument ? broad.version : 0) + 1,
      ...(pattern ? { pattern } : {}), ...(restoreOnlyDocument ? { resourceOnly: true } : {}),
      sourceTaskId: c.taskId, successReceiptId: success.id, successOperationId: success.operationId,
      observedAt: Math.max(previous?.observedAt ?? 0, success.at),
      matched: previous?.matched ?? 0, applied: previous?.applied ?? 0, successes: (previous?.successes ?? 0) + 1,
      failures: previous?.failures ?? 0, disabled: false,
      ...(previous?.exceptions ? { exceptions: previous.exceptions.filter(item => item !== restriction) } : {}),
      ...((invalidation || previous?.restoredFrom) ? { restoredFrom: invalidation ?? previous!.restoredFrom! } : {}) };
    memory.routes = [route, ...memory.routes.filter(item => item.id !== id)];
    learned.add(id);
  }
  return learned.size;
}

function updateRoutes(memory: RoomExecutionMemory, c: TaskContext, receipts: HostAcquisition[]) {
  for (const work of c.intents) {
    const route = work.learnedReadRoute;
    if (!route || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) continue;
    const current = memory.routes.find(item => item.id === route.id && item.version === route.version);
    if (!current) continue;
    current.matched++;
    if (routeObservation(c, work, receipts, false)) current.applied++;
    const receipt = routeObservation(c, work, receipts);
    if (!receipt) continue;
    if (receipt.status === 'acquired') {
      current.successes++;
      current.observedAt = Math.max(current.observedAt, receipt.at);
      continue;
    }
    const evidence: ReadRefutation = { resource: receipt.requestedResource, receiptId: receipt.id,
      at: receipt.at, taskId: c.taskId, version: route.version };
    current.failures++;
    if (receipt.authenticationScope === 'pattern') {
      // A document-scoped restored route shares the same credential as the original route.
      for (const item of memory.routes.filter(item => item.pattern?.binding === current.pattern?.binding
        && item.configuration === current.configuration && item.observedAt <= evidence.at)) {
        item.disabled = true;
        item.invalidatedBy = evidence;
      }
    } else {
      current.exceptions = [evidence, ...(current.exceptions ?? []).filter(item => !sameResourceIdentity(item.resource, evidence.resource))];
    }
  }
}

function partitionSources(c: TaskContext, revision: string, receipts: HostAcquisition[], gaps: CollectionGap[]): ReusablePartition[] {
  const round = c.discussion, plan = round?.mapReduce;
  if (!plan || plan.summaryLayer || !plan.queue || round.epoch !== c.epoch || round.goalVersion !== c.goalVersion) return [];
  const sources = requiredResources(c);
  return plan.partitions.flatMap(definition => {
    const part = plan.queue!.find(item => item.partitionId === definition.id);
    if (part?.status !== 'succeeded' || !part.workId || !part.resultRef) return [];
    const result = round.results.find(item => item.id === part.resultRef && item.workId === part.workId);
    if (!result || (!result.answer.trim() && !result.artifactIds.length)) return [];
    const [resource, extra] = partitionResources(c, definition.id);
    const requirement = resource && sources.find(item => sameResourceIdentity(item.resource, resource));
    if (!resource || extra || !requirement) {
      gaps.push({ kind: 'partition', id: part.partitionId, reason: 'source-unbound' });
      return [];
    }
    const work = c.intents.find(item => item.id === part.workId);
    const receipt = receipts.filter(item => item.workId === work?.id && item.attempt === work?.attempt
      && (!requirement.contentHash || requirement.contentHash === item.contentHash)
      && sameResourceIdentity(item.resource, resource) && verifiedResourceAcquisition(item)).sort((a, b) => b.at - a.at)[0];
    if (!receipt?.contentHash) {
      gaps.push({ kind: 'partition', id: part.partitionId, reason: 'verified-body-missing' });
      return [];
    }
    return [{ resource, contentHash: receipt.contentHash, evidenceId: receipt.id, sourceTaskId: c.taskId,
      sourcePartitionId: part.partitionId, publicationRevision: revision, resultRef: part.resultRef, contractHash: digest(partitionContract(c, definition)) }];
  });
}

export function collectExecutionMemory(memory: RoomExecutionMemory, c: TaskContext, revision: string): void {
  const checkpoint = memoryCheckpoint(c);
  if (checkpoint?.key !== revision || memory.processed[c.taskId] === revision) return;
  const configuration = mapConfigurationKey(c);
  const receipts = savedAcquisitions(c).filter(item => item.epoch === c.epoch
    && item.at <= (checkpoint.publishedAt ?? c.lastActivityAt)
    && item.configuration?.id === 'task-protocol' && item.configuration.version === configuration);
  updateRoutes(memory, c, receipts);
  memory.processed[c.taskId] = revision;
  if (checkpoint.publishedAt === undefined) return;
  const gaps: CollectionGap[] = [];
  const observations = learnObservations(c, receipts);
  const observationIds = new Set(observations.map(item => item.id));
  memory.observations = [...observations, ...(memory.observations ?? []).filter(item => !observationIds.has(item.id))].slice(0, 128);
  const routes = learnRoutes(memory, c, receipts, gaps);
  memory.routes.sort((a, b) => b.observedAt - a.observedAt);
  memory.routes = memory.routes.slice(0, 64);
  const updates = partitionSources(c, revision, receipts, gaps);
  memory.partitions = [...updates, ...memory.partitions.filter(old => old.sourceTaskId !== c.taskId && !updates.some(source =>
    source.contractHash === old.contractHash && source.contentHash === old.contentHash && sameResourceIdentity(source.resource, old.resource)))].slice(0, 128);
  const collections = memory.collections ??= {};
  delete collections[c.taskId];
  collections[c.taskId] = { revision, observations: observations.length, routes, partitions: updates.length, gaps };
  const oldest = Object.keys(collections).slice(0, -128);
  for (const taskId of oldest) delete collections[taskId];
}

export function taskExecutionMemory(memory: RoomExecutionMemory | undefined, config: TeamConfig, inventory: ToolInventorySnapshot | undefined,
  text: string, loadPublishedTask: (taskId: string) => TaskContext | undefined, requirements?: readonly ResourceRequirement[]): TaskExecutionMemory {
  const configuration = JSON.stringify([config.version, config.toolVersion]);
  const routes = memory?.routes.filter(route => !route.disabled && route.configuration === configuration) ?? [];
  const reading = inventory?.reading;
  const observations = memory?.observations ?? [];
  const sources = [...pinnedSource(text), ...(requirements ?? []).filter(item => item.freshness === 'saved' && item.contentHash)];
  const partitions = memory?.partitions.filter(source => sources.some(pin => pin.contentHash === source.contentHash
    && sameResourceIdentity(pin.resource, source.resource))).slice(0, 16).flatMap(source => {
    const original = loadPublishedTask(source.sourceTaskId);
    if (original?.publishedDelivery?.revision !== source.publicationRevision
      || original.publishedDelivery.goalVersion !== original.goalVersion) return [];
    const result = original.discussion?.results.find(item => item.id === source.resultRef && item.status === 'success');
    const definition = original.discussion?.mapReduce?.partitions.find(item => item.id === source.sourcePartitionId);
    if (!result || !definition) return [];
    const contract = partitionContract(original, definition);
    if (digest(contract) !== source.contractHash) return [];
    const artifacts = original.artifacts.filter(artifact => artifact.goalVersion === original.goalVersion && result.artifactIds.includes(artifact.id));
    return [{ source, contract, target: result.target, answer: result.answer, artifacts }];
  }) ?? [];
  return { routes, partitions, observations, patterns: reading?.patterns ?? [] };
}
