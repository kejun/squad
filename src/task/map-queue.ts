import type { Candidate, DiscussionRound, Intent, MapPartitionRun, TaskContext, TaskEvent } from '../types.js';
import { localEnabled, localPhysicalPending } from '../local-operation.js';
import { availableMapReduceMembers, mapQueueWindowDeadline } from './map-reduce-capacity.js';
import { discussionIntent, summarizeDiscussion } from './discussion.js';
import { assignSummaryBatch } from './hierarchical-summary.js';
import { hostRetryReservation } from '../host-retry.js';
import { consumePartitionMethod, newPartitionMethod, partitionMayDispatch, schedulingState, sharedPrerequisiteFailures } from './map-scheduling.js';
import { release } from './operations.js';
import { taskHumanGate, windowExpired } from './resilience.js';
import { requiredResources } from '../resource-acquisition.js';
import { historicalRouteDispatch } from './execution-memory.js';
import { aggregationGroupPayload } from './result-aggregation.js';

const active = (part: MapPartitionRun) => ['running', 'uncertain'].includes(part.status);
function mayDispatch(c: TaskContext, part: MapPartitionRun, target: string): boolean {
  const group = c.discussion?.mapReduce?.resultAggregation?.[part.partitionId];
  return group ? group.inline || localEnabled(c.config, target) : partitionMayDispatch(c, part, target) && historicalRouteDispatch(c, part.partitionId, target) !== 'wait';
}
export const queuedMapPartitions = (c: TaskContext) => c.discussion?.status === 'collecting'
  ? c.discussion.mapReduce?.queue?.filter(part => part.status === 'queued').length ?? 0 : 0;

const obsoleteCriterion = (item: { id: string }) => item.id.startsWith('map-recovery:');
function restoreCandidate(candidate: Candidate | null | undefined): void {
  if (!candidate) return;
  Reflect.deleteProperty(candidate, 'partitionRecoveries');
  if (candidate.acceptance) candidate.acceptance.criteria = candidate.acceptance.criteria.filter(item => !obsoleteCriterion(item));
  if (/^(?:MAP_RECOVERY_|CHECK_RECOVERY_SOURCE_REQUIRED)/.test(candidate.deliveryIssue?.code ?? '')) delete candidate.deliveryIssue;
}

/** Drop the retired declaration protocol at the saved-task boundary; never dispatch or reset spent budgets. */
function retireRecoveryProtocol(c: TaskContext): void {
  restoreCandidate(c.candidate);
  for (const work of c.intents) {
    restoreCandidate(work.payload.candidate as Candidate | undefined);
    Reflect.deleteProperty(work.payload, 'partitionRecoveries');
    Reflect.deleteProperty(work.payload, 'deliveryRevision');
    if (work.checkDiagnostics) work.checkDiagnostics = work.checkDiagnostics.filter(record => !['CHECK_SOURCE_NOT_FOUND', 'CHECK_SOURCE_QUOTE_MISMATCH'].includes(record.diagnostic.code));
    if (typeof work.payload.reason === 'string' && /^(?:MAP_RECOVERY_|CHECK_RECOVERY_SOURCE_REQUIRED)/.test(work.payload.reason))
      work.payload.reason = '按原任务要求继续普通交付';
    const findings = work.payload.priorFindings as { criterionId: string }[] | undefined;
    if (findings) work.payload.priorFindings = findings.filter(item => !item.criterionId.startsWith('map-recovery:'));
    if (work.criteriaResults) work.criteriaResults = work.criteriaResults.filter(item => !item.criterionId.startsWith('map-recovery:'));
    for (const round of [work.payload.discussion as DiscussionRound | undefined]) {
      for (const part of round?.mapReduce?.queue ?? []) Reflect.deleteProperty(part, 'resolution');
    }
  }
  for (const part of c.discussion?.mapReduce?.queue ?? []) Reflect.deleteProperty(part, 'resolution');
  for (const result of c.discussion?.results ?? []) {
    const reported = Reflect.get(result, 'reportedStatus') as typeof result.status | undefined;
    if (reported) {
      result.status = reported;
      const part = c.discussion?.mapReduce?.queue?.find(item => item.resultRef === result.id);
      if (part?.reason === 'RESOURCE_ACQUISITION_UNVERIFIED') { part.status = reported === 'success' ? 'succeeded' : reported; delete part.reason; }
    }
    for (const key of ['reportedStatus', 'missingResources', 'sourceOperationIds', 'resourceSources']) Reflect.deleteProperty(result, key);
    if (result.status === 'failed' || result.status === 'timeout') {
      result.reason ??= result.answer; result.answer = ''; result.artifactIds = [];
    }
  }
  if (/^(?:MAP_RECOVERY_|CHECK_RECOVERY_SOURCE_REQUIRED)/.test(c.reason)) c.reason = '';
  if (c.deliveryGaps) c.deliveryGaps = c.deliveryGaps.filter(gap => !/^(?:MAP_RECOVERY_|CHECK_RECOVERY_SOURCE_REQUIRED)/.test(gap.reason));
}

/** Legacy read migration: one old assignment per partition, no new dispatch. */
export function restoreMapQueue(c: TaskContext): void {
  retireRecoveryProtocol(c);
  const round = c.discussion, plan = round?.mapReduce;
  if (!round || !plan || plan.queue) return;
  plan.concurrency = Math.max(1, round.targets.length);
  plan.queue = plan.partitions.map(part => {
    const assignment = plan.assignments.find(item => item.partitionId === part.id);
    const work = c.intents.find(item => item.discussionId === round.id && item.kind === 'assistance'
      && item.target === assignment?.target);
    const result = round.results.find(item => item.target === assignment?.target);
    return { partitionId: part.id, attempt: work ? 1 : 0, deadline: work?.deadline ?? c.lastActivityAt + c.config.limits.workTimeoutMs,
      ...(work ? { workId: work.id, target: work.target } : {}),
      status: result ? result.status === 'success' ? 'succeeded' : result.status
        : !work || work.status === 'cancelled' || work.status === 'done' ? 'cancelled'
          : work.status === 'uncertain' ? 'uncertain' : 'running' };
  });
}

function current(c: TaskContext) {
  const round = c.discussion;
  return !!round?.mapReduce?.queue && round.status === 'collecting' && !c.stopped && c.outcome === null
    && round.epoch === c.epoch && round.goalVersion === c.goalVersion;
}

function partitionDeadline(c: TaskContext, part: MapPartitionRun, work?: Intent): number {
  return Math.min(part.deadline, mapQueueWindowDeadline(c), work?.deadline ?? part.deadline);
}

export function mapClaimDeadline(c: TaskContext, work: Intent): number | undefined {
  if (!work.discussionId || !current(c) || work.discussionId !== c.discussion!.id) return undefined;
  const part = c.discussion!.mapReduce!.queue!.find(item => item.workId === work.id && active(item));
  if (part) return partitionDeadline(c, part, work);
}

function waitingExpired(c: TaskContext, part: MapPartitionRun, at: number): boolean {
  if (part.status === 'queued') return at >= partitionDeadline(c, part);
  const work = c.intents.find(item => item.id === part.workId);
  return active(part) && work?.status === 'pending' && work.attempt === 0 && at >= partitionDeadline(c, part, work);
}

function observedStatus(c: TaskContext, part: MapPartitionRun): MapPartitionRun['status'] {
  if (!active(part)) return part.status;
  const work = c.intents.find(item => item.id === part.workId);
  if (work?.status === 'uncertain' || work?.localOperations?.some(op => op.status === 'uncertain')) return 'uncertain';
  if (work && localPhysicalPending(work)) return 'running';
  if (!work || ['done', 'cancelled'].includes(work.status)) return current(c) ? 'failed' : 'cancelled';
  return 'running';
}

function queueBudget(c: TaskContext, extra = 0): boolean {
  const round = c.discussion!, queued = queuedMapPartitions(c) + extra;
  const pending = c.intents.filter(work => work.discussionId === round.id && work.status === 'pending').length;
  const downstreamRequests = round.mapReduce?.summaryLayer || round.mapReduce?.resultAggregation ? 1 : 2;
  return c.usage.assists + queued <= c.config.limits.assists
    && c.usage.ordinary + pending + queued + downstreamRequests + hostRetryReservation(c) <= c.config.limits.ordinary;
}

function canReevaluate(c: TaskContext, at: number): MapPartitionRun | undefined {
  const round = c.discussion, plan = round?.mapReduce;
  if (!plan?.queue || plan.resultAggregation || c.stopped || c.outcome !== null || round!.epoch !== c.epoch || round!.goalVersion !== c.goalVersion
    || round!.status === 'cancelled' || c.usage.retries >= c.config.limits.retries
    || c.intents.some(work => work.discussionId === round!.id && work.kind === 'discussionSummary' && work.status === 'inflight')) return undefined;
  return plan.queue.find(part => ['failed', 'partial', 'timeout'].includes(part.status)
    && at < partitionDeadline(c, part, c.intents.find(work => work.id === part.workId))
    && !c.intents.some(work => work.id === part.workId && (work.replay === 'unsafe' || localPhysicalPending(work)))
    && c.config.bots.some(bot => bot.id !== c.owner && !!newPartitionMethod(c, part, bot.id)) && queueBudget(c, 1));
}

function reevaluateMapFailure(c: TaskContext, at: number): void {
  const part = canReevaluate(c, at);
  if (!part) return;
  const round = c.discussion!;
  for (const work of c.intents.filter(item => item.discussionId === round.id && item.kind === 'discussionSummary' && item.status === 'pending'))
    work.status = 'cancelled';
  round.status = 'collecting';
  part.status = 'queued'; part.reason = 'VERIFIED_METHOD_AVAILABLE';
  delete part.workId; delete part.target; delete part.resultRef;
  c.usage.retries++;
}

/** Logical skip leaves the actual process, operation receipt and resource custody untouched. */
export function skipCurrentPartition(c: TaskContext, workId: string, reason: string): boolean {
  const part = c.discussion?.mapReduce?.queue?.find(item => item.workId === workId && item.status !== 'succeeded');
  if (!part) return false;
  part.status = 'cancelled'; part.reason = reason;
  return true;
}

/** Pure decision used by the parent XState guard and its transaction-local action. */
export function mapQueueNeedsProgress(c: TaskContext, at: number): boolean {
  const queue = c.discussion?.mapReduce?.queue;
  if (!queue) return false;
  if (legacySummaryReady(c, at)) return true;
  if (canReevaluate(c, at)) return true;
  if (JSON.stringify(c.discussion!.mapReduce!.scheduling?.blockedPrerequisites ?? []) !== JSON.stringify(sharedPrerequisiteFailures(c))) return true;
  if (queue.some(part => observedStatus(c, part) !== part.status)) return true;
  if (!current(c)) return queue.some(part => part.status === 'queued');
  if (queue.some(part => waitingExpired(c, part, at))) return true;
  if (at >= mapQueueWindowDeadline(c)) return false;
  const queued = queue.filter(part => part.status === 'queued');
  if (!queue.some(part => active(part) || part.status === 'queued')) return true;
  if (queued.length && !queueBudget(c)) return true;
  return queued.length > 0 && queue.filter(active).length < c.discussion!.mapReduce!.concurrency!
    && availableMapReduceMembers(c).some(member => queued.some(part => mayDispatch(c, part, member.id)));
}

export function advanceMapQueue(c: TaskContext, e: TaskEvent): void {
  const round = c.discussion!, plan = round.mapReduce!, queue = plan.queue!;
  if (legacySummaryReady(c, e.at)) {
    for (const work of c.intents.filter(work => work.discussionId === round.id && work.kind === 'discussionSummary'
      && ['pending', 'inflight'].includes(work.status))) work.status = 'cancelled';
    summarizeDiscussion(c, e);
    return;
  }
  reevaluateMapFailure(c, e.at);
  const failures = sharedPrerequisiteFailures(c);
  if (failures.length || plan.scheduling) schedulingState(c).blockedPrerequisites = failures;
  const collecting = current(c);
  for (const part of queue) {
    if (collecting && waitingExpired(c, part, e.at)) {
      release(c, part.workId);
      const hardExpired = windowExpired(c, e.at);
      part.status = hardExpired ? 'timeout' : 'cancelled';
      part.reason = hardExpired ? 'WINDOW_EXPIRED' : 'WORK_EXPIRED';
      continue;
    }
    const status = observedStatus(c, part);
    if (status !== part.status) {
      part.status = status;
      if (status === 'failed' || status === 'cancelled') part.reason = '工作已结算但没有完整分片结果';
    }
    if (part.status === 'queued' && !collecting) {
      part.status = 'cancelled'; part.reason = 'ROUND_CANCELLED';
    }
  }
  if (!collecting || e.at >= mapQueueWindowDeadline(c)) return;
  if (!queueBudget(c)) for (const part of queue.filter(part => part.status === 'queued')) {
    part.status = 'cancelled'; part.reason = 'MAP_BUDGET_EXHAUSTED';
  }
  const slots = Math.max(0, plan.concurrency! - queue.filter(active).length);
  const members = availableMapReduceMembers(c);
  let dispatched = 0;
  for (const member of members) {
    if (dispatched >= slots) break;
    const part = queue.find(part => part.status === 'queued' && mayDispatch(c, part, member.id));
    if (!part) continue;
    const group = plan.resultAggregation?.[part.partitionId];
    const method = group ? undefined : consumePartitionMethod(c, part, member.id);
    const work = discussionIntent(c, e, 'assistance', member.id, group ? aggregationGroupPayload(c, group) : undefined);
    part.status = 'running'; part.attempt++; part.workId = work.id; part.target = member.id;
    work.deadline = partitionDeadline(c, part);
    work.payload.partitionAttempt = part.attempt;
    if (!round.targets.includes(member.id)) round.targets.push(member.id);
    if (!group) {
      const definition = plan.partitions.find(item => item.id === part.partitionId)!;
      const learned = !method && historicalRouteDispatch(c, part.partitionId, member.id);
      if (learned && learned !== 'wait') work.learnedReadRoute = learned;
      Object.assign(work.payload, { question: definition.objective, expected: definition.expectedOutput, partition: structuredClone(definition), instructions: member.instructions,
        ...(method ? { verifiedReadMethod: { id: method.id, sourceOperationId: method.sourceOperationId, resource: method.resource } } : {}) });
      if (definition.sourceIndices || c.config.executionMemory) {
        const resources = requiredResources(c, work);
        if (resources.length) work.payload.resourceRequirements = resources;
      }
      plan.assignments.push({ partitionId: part.partitionId, target: member.id, workId: work.id, attempt: part.attempt });
      if (plan.summaryLayer) assignSummaryBatch(c, work, part.partitionId);
      else work.payload.discussion = structuredClone(round);
    }
    c.usage.assists++; dispatched++;
  }
  if (queue.some(part => active(part) || part.status === 'queued')) return;
  const incomplete = queue.filter(part => part.status !== 'succeeded');
  if (!incomplete.length) delete round.incomplete;
  if (incomplete.length) round.incomplete = '部分分片未完整完成：' + incomplete.map(part => `${part.partitionId}（${part.status}${part.reason ? '：' + part.reason : ''}）`).join('；');
  summarizeDiscussion(c, e);
}

/** Older snapshots may be waiting for, or have failed to receive, the retired model response. */
function legacySummaryReady(c: TaskContext, at: number): boolean {
  const round = c.discussion, plan = round?.mapReduce;
  if (!round || !plan?.summaryLayer || plan.summaryLayer.topId || !plan.queue?.length || c.stopped || c.outcome !== null
    || round.epoch !== c.epoch || round.goalVersion !== c.goalVersion || at >= mapQueueWindowDeadline(c) || taskHumanGate(c)
    || !['summarizing', 'ready', 'delivered'].includes(round.status)) return false;
  return plan.queue.every(part => !active(part) && part.status !== 'queued')
    && !c.intents.some(work => work.discussionId === round.id && work.kind === 'discussionSummary' && localPhysicalPending(work));
}

/** Partition identity is stable when a member processes several parts or attempts. */
export function recordMapResult(c: TaskContext, e: TaskEvent, work: Intent, result: DiscussionRound['results'][number], transient = false): boolean {
  const round = c.discussion!, part = round.mapReduce?.queue?.find(item => item.workId === work.id && active(item));
  if (!part) return false;
  const id = `${round.id}:partition:${part.partitionId}:attempt:${part.attempt}`;
  round.results.push({ ...result, id, partitionId: part.partitionId, attempt: part.attempt, workId: work.id });
  part.status = result.status === 'success' ? 'succeeded' : result.status;
  delete part.reason;
  if (result.reason) part.reason = result.reason;
  part.resultRef = id;
  if (transient && current(c) && part.attempt < 2 && e.at < partitionDeadline(c, part, work)
    && c.usage.retries < c.config.limits.retries && queueBudget(c, 1) && !localPhysicalPending(work)) {
    part.status = 'queued'; delete part.workId; delete part.target; delete part.resultRef;
    c.usage.retries++;
  }
  if (['failed', 'partial', 'timeout'].includes(part.status)) {
    round.incomplete = `部分分片未完整完成：${part.partitionId}（${part.status}）`;
  }
  return true;
}
