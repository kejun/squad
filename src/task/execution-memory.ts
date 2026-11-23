import { sameResourceIdentity, savedAcquisitions, requiredResources, verifiedResourceAcquisition, type HostAcquisition, type ResourceIdentity } from '../resource-acquisition.js';
import { localEnabled, type Artifact, type Intent, type TaskContext } from '../types.js';
import { mapConfigurationKey, partitionResources } from './map-scheduling.js';
import type { ToolInventorySnapshot } from '../tool-inventory.js';
import type { MapReducePlan } from '../input-intent.js';

export interface ReadingPattern {
  urlPrefix: string;
  executable: string;
  execution: 'host' | 'sandbox';
  verifier: NonNullable<HostAcquisition['verifier']>;
  binding: string;
  accountKnown: boolean;
  argsPrefix?: string[];
  documentArgument?: boolean;
  separateDocumentId?: boolean;
}

export interface ReadingEnvironment {
  patterns: ReadingPattern[];
  protectedPrefixes: string[];
}

export interface ReadRefutation {
  resource: ResourceIdentity;
  receiptId: string;
  taskId: string;
  at: number;
  version: number;
}

export type ReadFailureObservation = {
  id: string;
  sourceTaskId: string;
  operationId: string;
  resource: ResourceIdentity;
  at: number;
} & ({ kind: 'web_login'; protectedPrefix?: string }
   | { kind: 'sandbox_ps'; pattern?: ReadingPattern });

export interface LearnedReadRoute {
  id: string;
  version: number;
  origin: string;
  catalog?: string; // Legacy records remain readable as history.
  configuration: string;
  executable: string;
  execution: 'host' | 'sandbox';
  verifier: NonNullable<HostAcquisition['verifier']>;
  sourceTaskId: string;
  successReceiptId: string;
  successOperationId: string;
  failedReceiptId?: string;
  pattern?: ReadingPattern;
  resource?: ResourceIdentity;
  exceptions?: ReadRefutation[];
  invalidatedBy?: ReadRefutation;
  restoredFrom?: ReadRefutation;
  resourceOnly?: true;
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
  patterns?: ReadingPattern[];
  observations?: ReadFailureObservation[];
  routes: LearnedReadRoute[];
  partitions: { source: ReusablePartition; contract: string; target: string; answer: string; artifacts: Artifact[] }[];
}

export function taskMemory(c: TaskContext) {
  return c.config.executionMemory && c.epoch === 1 && c.goalVersion === 1 ? c.executionMemory : undefined;
}

export function partitionContract(c: TaskContext, part: MapReducePlan['partitions'][number]): string {
  const withoutPins = (text: string) => text.replace(/(https?:\/\/[^\s]+)[ \t]+sha256:[a-f0-9]{64}(?=\s|$)/gi, '$1');
  const request = withoutPins(c.goal.text).replace(/^[ \t]*https?:\/\/[^\s]+[ \t]*\r?$/gm, '').replace(/\n{2,}/g, '\n').trim();
  return JSON.stringify([request, c.goal.constraints, c.goal.criteria, c.goal.requiredArtifacts,
    withoutPins(part.objective), withoutPins(part.expectedOutput)]);
}

export function readingDocumentId(resource: ResourceIdentity, prefix: string): string | undefined {
  if (resource.kind !== 'url' || !resource.url.startsWith(prefix)) return undefined;
  const id = resource.url.slice(prefix.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

export function resourceInReadingScope(resource: ResourceIdentity, prefix: string): boolean {
  return readingDocumentId(resource, prefix) !== undefined;
}

export function assignedReadingResource(c: TaskContext, partitionId: string): ResourceIdentity | undefined {
  const [assigned, extra] = partitionResources(c, partitionId);
  return assigned?.kind === 'url' && !extra && requiredResources(c).some(item => sameResourceIdentity(item.resource, assigned))
    ? assigned : undefined;
}

function applicableRoute(route: LearnedReadRoute, c: TaskContext, resource: ResourceIdentity, patterns?: ReadingPattern[]) {
  const pattern = route.pattern;
  return !!pattern?.accountKnown && !route.disabled && route.configuration === mapConfigurationKey(c)
    && resourceInReadingScope(resource, pattern.urlPrefix) && patterns?.some(item => item.binding === pattern.binding)
    && (!route.resourceOnly || !!route.resource && sameResourceIdentity(route.resource, resource))
    && !route.exceptions?.some(item => sameResourceIdentity(item.resource, resource));
}

export function learnedReadRoute(c: TaskContext, partitionId: string): LearnedReadRoute | undefined {
  const assigned = assignedReadingResource(c, partitionId), memory = taskMemory(c);
  if (!assigned || !memory) return undefined;
  const [best, next] = memory.routes.filter(route => applicableRoute(route, c, assigned, memory.patterns))
    .sort((a, b) => Number(!!b.resourceOnly) - Number(!!a.resourceOnly)
      || b.pattern!.urlPrefix.length - a.pattern!.urlPrefix.length || b.observedAt - a.observedAt);
  if (next && next.resourceOnly === best!.resourceOnly && next.pattern!.urlPrefix.length === best!.pattern!.urlPrefix.length && next.observedAt === best!.observedAt) return undefined;
  return best;
}

export function routeObservation(c: TaskContext, work: Intent, receipts = savedAcquisitions(c), settledOnly = true): HostAcquisition | undefined {
  const route = work.learnedReadRoute;
  const part = work.payload.partition as { id: string } | undefined;
  if (!route?.pattern || !part || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return undefined;
  const assigned = assignedReadingResource(c, part.id);
  if (!assigned) return undefined;
  const required = requiredResources(c, work).find(item => sameResourceIdentity(item.resource, assigned));
  return receipts.filter(receipt => receipt.workId === work.id && (receipt.attempt === work.attempt
      || receipt.attempt < work.attempt && (receipt.status === 'authentication_required' || receipt.status === 'resource_mismatch'))
      && receipt.configuration?.version === route.configuration && receipt.readingPattern?.binding === route.pattern!.binding
      && receipt.source === 'runCli' && sameResourceIdentity(assigned, receipt.requestedResource)
      && (!settledOnly || receipt.status === 'authentication_required' || receipt.status === 'resource_mismatch'
        || verifiedResourceAcquisition(receipt) && (!required?.contentHash || required.contentHash === receipt.contentHash)))
    .sort((a, b) => {
      const priority = (receipt: HostAcquisition) => receipt.authenticationScope === 'pattern' ? 2
        : Number(receipt.status === 'authentication_required' || receipt.status === 'resource_mismatch');
      return priority(b) - priority(a) || b.at - a.at;
    })[0];
}

function roundUses(c: TaskContext, route: LearnedReadRoute) {
  return c.intents.filter(work => work.discussionId === c.discussion?.id && work.learnedReadRoute?.id === route.id
    && work.learnedReadRoute.version === route.version);
}

function contraryRouteEvidence(c: TaskContext, uses: Intent[], resource: ResourceIdentity): boolean {
  if (!uses.length) return false;
  const receipts = savedAcquisitions(c);
  return uses.some((work, index) => {
    const observed = routeObservation(c, work, receipts);
    return observed && observed.status !== 'acquired' && (index === 0 || observed.authenticationScope === 'pattern'
      || sameResourceIdentity(resource, observed.requestedResource));
  });
}

export function recommendedReadRoute(c: TaskContext, work: Intent, inventory?: ToolInventorySnapshot): LearnedReadRoute | undefined {
  const route = work.learnedReadRoute;
  const part = work.payload.partition as { id: string } | undefined;
  const resource = part && assignedReadingResource(c, part.id);
  return route && resource && taskMemory(c) && applicableRoute(route, c, resource, inventory?.reading?.patterns)
    && !contraryRouteEvidence(c, roundUses(c, route), resource) ? route : undefined;
}

/** Wait only within an established scope. The current pilot receipt unlocks the recommendation. */
export function historicalRouteDispatch(c: TaskContext, partitionId: string, target: string): LearnedReadRoute | 'wait' | undefined {
  const route = learnedReadRoute(c, partitionId);
  if (!route) return undefined;
  const resource = assignedReadingResource(c, partitionId)!;
  const uses = roundUses(c, route);
  if (contraryRouteEvidence(c, uses, resource)) return undefined;
  const pilot = uses[0];
  const eligible = localEnabled(c.config, target);
  if (!pilot) {
    if (eligible) return route;
    return c.config.bots.some(bot => bot.id !== c.owner && localEnabled(c.config, bot.id)) ? 'wait' : undefined;
  }
  if (routeObservation(c, pilot)?.status === 'acquired') return eligible ? route : undefined;
  return ['pending', 'inflight', 'uncertain'].includes(pilot.status) ? 'wait' : undefined;
}

export function readingMatchReport(c: TaskContext) {
  const memory = taskMemory(c);
  if (!c.config.executionMemory) return;
  const round = c.discussion;
  const receipts = savedAcquisitions(c);
  return (round?.mapReduce?.partitions ?? []).map(part => {
    const source = assignedReadingResource(c, part.id);
    const candidates = source?.kind === 'url' ? memory?.routes.filter(route => route.origin === new URL(source.url).origin).length ?? 0 : 0;
    const offered = c.intents.filter(work => work.discussionId === round?.id && work.epoch === c.epoch && work.goalVersion === c.goalVersion
      && work.learnedReadRoute && (work.payload.partition as { id?: string } | undefined)?.id === part.id);
    const adopted = offered.filter(work => routeObservation(c, work, receipts, false)).length;
    const acquired = offered.filter(work => routeObservation(c, work, receipts)?.status === 'acquired').length;
    const reused = !!round?.mapReduce?.queue?.find(item => item.partitionId === part.id)?.reusedSource;
    return { partitionId: part.id, candidates, offered: offered.length, adopted, acquired, reused };
  });
}

export function reusablePartition(c: TaskContext, part: MapReducePlan['partitions'][number]) {
  const [assigned, extra] = partitionResources(c, part.id);
  const requirement = assigned && !extra && requiredResources(c).find(item => sameResourceIdentity(item.resource, assigned));
  if (!requirement || requirement.freshness !== 'saved' || !requirement.contentHash) return undefined;
  const contract = partitionContract(c, part);
  return taskMemory(c)?.partitions.find(match => match.contract === contract && match.source.contentHash === requirement.contentHash
    && sameResourceIdentity(match.source.resource, requirement.resource));
}
