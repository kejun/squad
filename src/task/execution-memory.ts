import { sameResourceIdentity, savedAcquisitions, requiredResources, type HostAcquisition, type ResourceIdentity } from '../resource-acquisition.js';
import { localEnabled, type Artifact, type Intent, type TaskContext } from '../types.js';
import { mapConfigurationKey, partitionResources } from './map-scheduling.js';
import type { ToolInventorySnapshot } from '../tool-inventory.js';
import type { MapReducePlan } from '../input-intent.js';

export interface LearnedReadRoute {
  id: string;
  version: number;
  origin: string;
  catalog: string;
  configuration: string;
  executable: string;
  execution: 'host' | 'sandbox';
  verifier: NonNullable<HostAcquisition['verifier']>;
  sourceTaskId: string;
  successReceiptId: string;
  successOperationId: string;
  failedReceiptId: string;
  observedAt: number;
  matched: number;
  applied: number;
  successes: number;
  failures: number;
  disabled: boolean;
}

export interface ReusedPartitionSource {
  sourceTaskId: string;
  publicationRevision: string;
  sourcePartitionId: string;
  evidenceId: string;
  resource: ResourceIdentity;
  contentHash: string;
}

export interface ReusablePartition extends ReusedPartitionSource {
  contractHash: string;
  resultRef: string;
}

export interface TaskExecutionMemory {
  catalog?: string;
  routes: LearnedReadRoute[];
  partitions: { source: ReusablePartition; contract: string; target: string; answer: string; artifacts: Artifact[] }[];
}

export function memoryCatalog(inventory: ToolInventorySnapshot | undefined): string | undefined {
  if (inventory?.refresh.status !== 'current') return undefined;
  return inventory.catalogVersion;
}

function taskMemory(c: TaskContext) {
  return c.config.executionMemory && c.epoch === 1 && c.goalVersion === 1 ? c.executionMemory : undefined;
}

export function partitionContract(c: TaskContext, part: MapReducePlan['partitions'][number]): string {
  const withoutPins = (text: string) => text.replace(/(https?:\/\/[^\s]+)[ \t]+sha256:[a-f0-9]{64}(?=\s|$)/gi, '$1');
  const request = withoutPins(c.goal.text).replace(/^[ \t]*https?:\/\/[^\s]+[ \t]*\r?$/gm, '').replace(/\n{2,}/g, '\n').trim();
  return JSON.stringify([request, c.goal.constraints, c.goal.criteria, c.goal.requiredArtifacts,
    withoutPins(part.objective), withoutPins(part.expectedOutput)]);
}

export function learnedReadRoute(c: TaskContext, partitionId: string): LearnedReadRoute | undefined {
  const [assigned, extra] = partitionResources(c, partitionId);
  if (assigned?.kind !== 'url' || extra || !requiredResources(c).some(item => sameResourceIdentity(item.resource, assigned))) return undefined;
  const origin = new URL(assigned.url).origin;
  return taskMemory(c)?.routes.find(route => route.origin === origin && route.configuration === mapConfigurationKey(c));
}

export function routeObservation(c: TaskContext, work: Intent, receipts = savedAcquisitions(c), settledOnly = true): HostAcquisition | undefined {
  const route = work.learnedReadRoute;
  const part = work.payload.partition as { id: string } | undefined;
  if (!route || !part || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return undefined;
  const assigned = partitionResources(c, part.id);
  const requirements = settledOnly ? requiredResources(c) : [];
  return receipts.filter(receipt => {
    const action = work.localOperations?.find(op => op.id === receipt.operationId)?.action;
    return receipt.workId === work.id && receipt.attempt === work.attempt
      && receipt.configuration?.version === route.configuration
      && receipt.verifier?.id === route.verifier.id && receipt.verifier?.version === route.verifier.version
      && (!settledOnly || receipt.status === 'authentication_required' || receipt.status === 'resource_mismatch'
        || receipt.status === 'acquired' && !requirements.some(item => item.contentHash
          && sameResourceIdentity(item.resource, receipt.resource) && item.contentHash !== receipt.contentHash))
      && action?.type === 'runCli' && action.executable === route.executable && (action.execution ?? 'sandbox') === route.execution
      && assigned.some(resource => sameResourceIdentity(resource, receipt.requestedResource));
  }).sort((left, right) => right.at - left.at)[0];
}

function roundUses(c: TaskContext, route: LearnedReadRoute) {
  return c.intents.filter(work => work.discussionId === c.discussion?.id && work.learnedReadRoute?.id === route.id);
}

function contraryRouteEvidence(c: TaskContext, uses: Intent[]): boolean {
  if (!uses.length) return false;
  const receipts = savedAcquisitions(c);
  return uses.some(work => {
    const observed = routeObservation(c, work, receipts);
    return observed && observed.status !== 'acquired';
  });
}

export function recommendedReadRoute(c: TaskContext, work: Intent, inventory?: ToolInventorySnapshot): LearnedReadRoute | undefined {
  const route = work.learnedReadRoute;
  return route && taskMemory(c) && route.catalog === memoryCatalog(inventory) && route.configuration === mapConfigurationKey(c)
    && !contraryRouteEvidence(c, roundUses(c, route)) ? route : undefined;
}

/** The pilot is a normal work intent. Only its current, matching receipt can release the recommendation. */
export function historicalRouteDispatch(c: TaskContext, partitionId: string, target: string): LearnedReadRoute | 'wait' | undefined {
  const route = learnedReadRoute(c, partitionId);
  if (!route) return undefined;
  const uses = roundUses(c, route);
  if (contraryRouteEvidence(c, uses)) return undefined;
  const pilot = uses[0];
  const eligible = localEnabled(c.config, target);
  if (!pilot) {
    if (eligible) return route;
    return c.config.bots.some(bot => bot.id !== c.owner && localEnabled(c.config, bot.id)) ? 'wait' : undefined;
  }
  if (routeObservation(c, pilot)?.status === 'acquired') return eligible ? route : undefined;
  return ['pending', 'inflight', 'uncertain'].includes(pilot.status) ? 'wait' : undefined;
}

export function reusablePartition(c: TaskContext, part: MapReducePlan['partitions'][number]) {
  const [assigned, extra] = partitionResources(c, part.id);
  const requirement = assigned && !extra && requiredResources(c).find(item => sameResourceIdentity(item.resource, assigned));
  if (!requirement || requirement.freshness !== 'saved' || !requirement.contentHash) return undefined;
  const contract = partitionContract(c, part);
  return taskMemory(c)?.partitions.find(match => match.contract === contract && match.source.contentHash === requirement.contentHash
    && sameResourceIdentity(match.source.resource, requirement.resource));
}
