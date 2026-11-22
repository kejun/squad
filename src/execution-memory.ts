import { createHash } from 'node:crypto';
import { pinnedSource, requiredResources, sameResourceIdentity, savedAcquisitions, verifiedResourceAcquisition,
  type HostAcquisition, type ResourceRequirement } from './resource-acquisition.js';
import { memoryCatalog, partitionContract, routeObservation, type LearnedReadRoute, type ReusablePartition,
  type TaskExecutionMemory } from './task/execution-memory.js';
import { mapConfigurationKey, partitionResources } from './task/map-scheduling.js';
import type { TaskContext, TeamConfig } from './types.js';
import type { ToolInventorySnapshot } from './tool-inventory.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export interface RoomExecutionMemory {
  pending: Record<string, string>;
  processed: Record<string, string>;
  routes: LearnedReadRoute[];
  partitions: ReusablePartition[];
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

function learnRoutes(memory: RoomExecutionMemory, c: TaskContext, inventory: ToolInventorySnapshot,
  catalog: string, receipts: HostAcquisition[]) {
  const configuration = mapConfigurationKey(c);
  const sources = requiredResources(c);
  const successes = receipts.filter(item => item.source === 'runCli' && verifiedResourceAcquisition(item));
  for (const success of successes) {
    const { resource, verifier } = success;
    if (resource.kind !== 'url' || !verifier || success.configuration?.authentication !== 'satisfied'
      || !sources.some(item => sameResourceIdentity(item.resource, resource))) continue;
    const url = new URL(resource.url);
    const work = c.intents.find(item => item.id === success.workId)!;
    const action = work.localOperations?.find(item => item.id === success.operationId)?.action;
    if (action?.type !== 'runCli') continue;
    const execution = action.execution ?? 'sandbox';
    if (!inventory.cli.entries.some(entry => entry.command === action.executable
      && (entry.execution ?? 'sandbox') === execution && entry.domains?.includes(url.hostname))) continue;
    const failed = receipts.find(item => item.source === 'webFetch' && item.status === 'authentication_required' && item.verifier
      && item.at <= success.at && sameResourceIdentity(item.requestedResource, resource));
    if (!failed) continue;
    const id = digest(JSON.stringify([url.origin, configuration, catalog, action.executable, execution, verifier]));
    const previous = memory.routes.find(route => route.id === id);
    if (previous && (!previous.disabled || success.at <= previous.observedAt || c.intents.some(work => work.learnedReadRoute?.id === id))) continue;
    const route: LearnedReadRoute = { id, version: (previous?.version ?? 0) + 1, origin: url.origin, catalog, configuration,
      executable: action.executable, execution, verifier, sourceTaskId: c.taskId, successReceiptId: success.id, successOperationId: success.operationId,
      failedReceiptId: failed.id, observedAt: success.at, matched: 0, applied: 0, successes: 1, failures: 0, disabled: false };
    memory.routes = [route, ...memory.routes.filter(item => item.id !== id)];
  }
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
    current.observedAt = Math.max(current.observedAt, receipt.at);
    if (receipt.status === 'acquired') current.successes++;
    else { current.failures++; current.disabled = true; }
  }
}

function partitionSources(c: TaskContext, revision: string, receipts: HostAcquisition[]): ReusablePartition[] {
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
    if (!resource || extra || !requirement) return [];
    const work = c.intents.find(item => item.id === part.workId);
    const receipt = receipts.filter(item => item.workId === work?.id && item.attempt === work?.attempt
      && (!requirement.contentHash || requirement.contentHash === item.contentHash)
      && sameResourceIdentity(item.resource, resource) && verifiedResourceAcquisition(item)).sort((a, b) => b.at - a.at)[0];
    if (!receipt?.contentHash) return [];
    return [{ resource, contentHash: receipt.contentHash, evidenceId: receipt.id, sourceTaskId: c.taskId,
      sourcePartitionId: part.partitionId, publicationRevision: revision, resultRef: part.resultRef, contractHash: digest(partitionContract(c, definition)) }];
  });
}

export function collectExecutionMemory(memory: RoomExecutionMemory, c: TaskContext, revision: string, inventory?: ToolInventorySnapshot): void {
  const checkpoint = memoryCheckpoint(c);
  if (checkpoint?.key !== revision || memory.processed[c.taskId] === revision) return;
  const configuration = mapConfigurationKey(c);
  const receipts = savedAcquisitions(c).filter(item => item.epoch === c.epoch
    && item.at <= (checkpoint.publishedAt ?? c.lastActivityAt)
    && item.configuration?.id === 'task-protocol' && item.configuration.version === configuration);
  updateRoutes(memory, c, receipts);
  memory.processed[c.taskId] = revision;
  if (checkpoint.publishedAt === undefined) return;
  const catalog = memoryCatalog(inventory);
  if (inventory && catalog && c.executionMemory?.catalog === catalog) learnRoutes(memory, c, inventory, catalog, receipts);
  memory.routes.sort((a, b) => b.observedAt - a.observedAt);
  memory.routes = memory.routes.slice(0, 64);
  const updates = partitionSources(c, revision, receipts);
  memory.partitions = [...updates, ...memory.partitions.filter(old => old.sourceTaskId !== c.taskId && !updates.some(source =>
    source.contractHash === old.contractHash && source.contentHash === old.contentHash && sameResourceIdentity(source.resource, old.resource)))].slice(0, 128);
}

export function taskExecutionMemory(memory: RoomExecutionMemory | undefined, config: TeamConfig, catalog: string | undefined,
  text: string, loadPublishedTask: (taskId: string) => TaskContext | undefined, requirements?: readonly ResourceRequirement[]): TaskExecutionMemory {
  const configuration = JSON.stringify([config.version, config.toolVersion]);
  const routes = memory?.routes.filter(route => !route.disabled && route.catalog === catalog && route.configuration === configuration)
    .sort((a, b) => b.successes - a.successes || b.observedAt - a.observedAt) ?? [];
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
  return { ...(catalog ? { catalog } : {}), routes, partitions };
}
