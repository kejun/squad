import type { DiscussionRound, Intent, MapPartitionRun, TaskContext, TaskEvent } from '../types.js';
import { localPhysicalPending } from '../local-operation.js';
import { availableMapReduceMembers } from './map-reduce-capacity.js';
import { discussionIntent, summarizeDiscussion } from './discussion.js';
import { hostRetryReservation } from '../host-retry.js';

const active = (part: MapPartitionRun) => ['running', 'uncertain'].includes(part.status);
export const queuedMapPartitions = (c: TaskContext) => c.discussion?.status === 'collecting'
  ? c.discussion.mapReduce?.queue?.filter(part => part.status === 'queued').length ?? 0 : 0;

/** Legacy read migration: one old assignment per partition, no new dispatch. */
export function restoreMapQueue(c: TaskContext): void {
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
  return c.usage.assists + queued <= c.config.limits.assists
    && c.usage.ordinary + pending + queued + 2 + hostRetryReservation(c) <= c.config.limits.ordinary;
}

/** Pure decision used by the parent XState guard and its transaction-local action. */
export function mapQueueNeedsProgress(c: TaskContext, at: number): boolean {
  const queue = c.discussion?.mapReduce?.queue;
  if (!queue) return false;
  if (queue.some(part => observedStatus(c, part) !== part.status)) return true;
  if (!current(c)) return queue.some(part => part.status === 'queued');
  const queued = queue.filter(part => part.status === 'queued');
  if (!queue.some(part => active(part) || part.status === 'queued')) return true;
  if (queued.some(part => at >= part.deadline) || queued.length && !queueBudget(c)) return true;
  return queued.length > 0 && queue.filter(active).length < c.discussion!.mapReduce!.concurrency!
    && availableMapReduceMembers(c).length > 0;
}

export function advanceMapQueue(c: TaskContext, e: TaskEvent): void {
  const round = c.discussion!, plan = round.mapReduce!, queue = plan.queue!;
  for (const part of queue) {
    const status = observedStatus(c, part);
    if (status !== part.status) {
      part.status = status;
      if (status === 'failed' || status === 'cancelled') part.reason = '工作已结算但没有完整分片结果';
    }
    if (part.status === 'queued' && (!current(c) || e.at >= part.deadline)) {
      part.status = 'cancelled'; part.reason = current(c) ? 'WORK_EXPIRED' : 'ROUND_CANCELLED';
    }
  }
  if (!current(c)) return;
  if (!queueBudget(c)) for (const part of queue.filter(part => part.status === 'queued')) {
    part.status = 'cancelled'; part.reason = 'MAP_BUDGET_EXHAUSTED';
  }
  const slots = Math.max(0, plan.concurrency! - queue.filter(active).length);
  const members = availableMapReduceMembers(c).slice(0, slots);
  for (const member of members) {
    const part = queue.find(part => part.status === 'queued');
    if (!part) break;
    const definition = plan.partitions.find(item => item.id === part.partitionId)!;
    const work = discussionIntent(c, e, 'assistance', member.id);
    part.status = 'running'; part.attempt++; part.workId = work.id; part.target = member.id;
    work.deadline = part.deadline;
    Object.assign(work.payload, { question: definition.objective, expected: definition.expectedOutput,
      partition: structuredClone(definition), partitionAttempt: part.attempt, instructions: member.instructions });
    plan.assignments.push({ partitionId: part.partitionId, target: member.id, workId: work.id, attempt: part.attempt });
    if (!round.targets.includes(member.id)) round.targets.push(member.id);
    work.payload.discussion = structuredClone(round);
    c.usage.assists++;
  }
  if (queue.some(part => active(part) || part.status === 'queued')) return;
  const incomplete = queue.filter(part => part.status !== 'succeeded');
  if (incomplete.length) round.incomplete = '部分分片未完整完成：' + incomplete.map(part => `${part.partitionId}（${part.status}${part.reason ? '：' + part.reason : ''}）`).join('；');
  summarizeDiscussion(c, e);
}

/** Partition identity is stable when a member processes several parts or attempts. */
export function recordMapResult(c: TaskContext, e: TaskEvent, work: Intent, result: DiscussionRound['results'][number], transient = false): boolean {
  const round = c.discussion!, part = round.mapReduce?.queue?.find(item => item.workId === work.id && active(item));
  if (!part) return false;
  const id = `${round.id}:partition:${part.partitionId}:attempt:${part.attempt}`;
  round.results.push({ ...result, id, partitionId: part.partitionId, attempt: part.attempt, workId: work.id });
  part.status = result.status === 'success' ? 'succeeded' : result.status;
  part.resultRef = id;
  if (transient && current(c) && part.attempt < 2 && e.at < part.deadline
    && c.usage.retries < c.config.limits.retries && queueBudget(c, 1) && !localPhysicalPending(work)) {
    part.status = 'queued'; delete part.workId; delete part.target; delete part.resultRef;
    c.usage.retries++;
  }
  return true;
}
