import type { TaskContext, TaskEvent } from '../types.js';
import { discussionActive, fence, unresolvedInput } from './facts.js';
import { advanceMapQueue } from './map-queue.js';
import { message } from './operations.js';
import { availableMapReduceMembers, mapReduceCapacity } from './map-reduce-capacity.js';
import { reusablePartition } from './execution-memory.js';
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
  const targets = members.slice(0, plan.partitions.length);
  const round: NonNullable<TaskContext['discussion']> = { id: `map-reduce:${input.id}`, request: input.rawText, targets: targets.map(bot => bot.id),
    status: 'collecting', results: [], skipped: [], mapReduce: { ...structuredClone(plan), inputId: input.id,
      assignments: [], concurrency: targets.length,
      queue: plan.partitions.map(part => ({ partitionId: part.id, attempt: 0, status: 'queued', deadline: Math.min(e.at + c.config.limits.workTimeoutMs, processingWindow(c).hardDeadline, processingWindow(c).repairDeadline ?? Number.MAX_SAFE_INTEGER) })) }, ...fence(c) };
  const matches = plan.partitions.map(part => reusablePartition({ ...c, discussion: round }, part));
  const remaining = matches.filter(match => !match).length;
  if (remaining > mapReduceCapacity(c)) {
    const reason = !members.length ? '可用成员不足'
      : c.config.limits.assists - c.usage.assists < remaining ? '协助额度不足' : '普通额度不足';
    message(c, e, 'facilitator', `未启动并行分片：${reason}。全部分片和归并要求交由原负责人处理。`, 'notice');
    return false;
  }
  c.discussion = round;
  for (const [index, match] of matches.entries()) {
    if (!match) continue;
    const part = round.mapReduce!.queue![index]!;
    const resultRef = `${round.id}:partition:${part.partitionId}:reused`;
    const artifactIds = match.artifacts.map((original, artifactIndex) => {
      const id = `${c.taskId}:artifact:${resultRef}:${artifactIndex + 1}`;
      c.artifacts.push({ id, documentId: id, revision: 1, goalVersion: c.goalVersion, name: original.name, content: original.content,
        ...(original.author ? { author: original.author } : {}), ...(original.sourceItems ? { sourceItems: original.sourceItems } : {}),
        reusedFrom: { sourceTaskId: match.source.sourceTaskId, artifactId: original.id } });
      return id;
    });
    const { contractHash: _contract, resultRef: _oldResult, ...source } = match.source;
    Object.assign(part, { status: 'succeeded', target: match.target, resultRef, reusedSource: source });
    round.results.push({ id: resultRef, partitionId: part.partitionId, attempt: 0, target: match.target,
      status: 'success', answer: match.answer, artifactIds });
  }
  if (c.executionMemory) c.executionMemory.partitions = [];
  advanceMapQueue(c, e);
  const reused = matches.length - remaining;
  message(c, e, 'facilitator', reused
    ? `已复用 ${reused} 个分片，剩余 ${remaining} 个独立分片全部结算后归并，再交回 ${c.owner}。`
    : `已安排 ${plan.partitions.length} 个独立分片，最多 ${targets.length} 名成员同时执行；全部结算后归并，再交回 ${c.owner}。`, 'notice');
  return true;
}
