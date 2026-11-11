import type { TaskContext, TaskEvent } from '../types.js';
import { discussionActive, fence, unresolvedInput } from './facts.js';
import { advanceMapQueue } from './map-queue.js';
import { message } from './operations.js';
import { availableMapReduceMembers, mapReduceCapacity } from './map-reduce-capacity.js';
import { processingWindow } from './resilience.js';

/** Pure task transition: the host, never the interpretation, owns member assignment. */
export function startMapReduce(c: TaskContext, e: TaskEvent): boolean {
  const input = c.inputAnalyses?.filter(item => item.status === 'resolved'
    && item.epoch === c.epoch && item.goalVersion === c.goalVersion).at(-1);
  if (!input?.spec?.decomposition || input.decompositionApplied || unresolvedInput(c)
    || c.inputs.some(note => !note.applied)) return false;
  input.decompositionApplied = true;
  const plan = input.spec.decomposition;
  if (!['request', 'supplement'].includes(input.action) || discussionActive(c)
    || c.review && !['complete', 'cancelled'].includes(c.review.status)) return false;
  const members = availableMapReduceMembers(c);
  if (plan.partitions.length > mapReduceCapacity(c)) {
    const reason = !members.length ? '可用成员不足'
      : c.config.limits.assists - c.usage.assists < plan.partitions.length ? '协助额度不足' : '普通额度不足';
    message(c, e, 'facilitator', `未启动并行分片：${reason}。全部分片和归并要求交由原负责人处理。`, 'notice');
    return false;
  }
  const targets = members.slice(0, plan.partitions.length);
  c.discussion = { id: `map-reduce:${input.id}`, request: input.rawText, targets: targets.map(bot => bot.id),
    status: 'collecting', results: [], skipped: [], mapReduce: { ...structuredClone(plan), inputId: input.id,
      assignments: [], concurrency: targets.length,
      queue: plan.partitions.map(part => ({ partitionId: part.id, attempt: 0, status: 'queued', deadline: Math.min(e.at + c.config.limits.workTimeoutMs, processingWindow(c).hardDeadline, processingWindow(c).repairDeadline ?? Number.MAX_SAFE_INTEGER) })) }, ...fence(c) };
  advanceMapQueue(c, e);
  message(c, e, 'facilitator', `已安排 ${plan.partitions.length} 个独立分片，最多 ${targets.length} 名成员同时执行；全部结算后归并，再交回 ${c.owner}。`, 'notice');
  return true;
}
