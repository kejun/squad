import type { TaskContext, TaskEvent } from '../types.js';
import { discussionActive, fence, unresolvedInput } from './facts.js';
import { discussionIntent } from './discussion.js';
import { message } from './operations.js';

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
  const busy = new Set(c.intents.filter(work => work.kind !== 'cancel'
    && ['pending', 'inflight', 'uncertain'].includes(work.status)).map(work => work.target));
  const members = c.config.bots.filter(bot => bot.id !== c.owner && !busy.has(bot.id));
  const reason = members.length < plan.partitions.length ? '可用成员不足'
    : c.config.limits.assists - c.usage.assists < plan.partitions.length ? '协助额度不足'
    : c.config.limits.ordinary - c.usage.ordinary < plan.partitions.length + 2 ? '普通额度不足' : undefined;
  if (reason) {
    message(c, e, 'facilitator', `未启动并行分片：${reason}。全部分片和归并要求交由原负责人处理。`, 'notice');
    return false;
  }
  const targets = members.slice(0, plan.partitions.length);
  c.discussion = { id: `map-reduce:${input.id}`, request: input.rawText, targets: targets.map(bot => bot.id),
    status: 'collecting', results: [], skipped: [], mapReduce: { ...structuredClone(plan), inputId: input.id,
      assignments: plan.partitions.map((part, index) => ({ partitionId: part.id, target: targets[index]!.id })) }, ...fence(c) };
  for (const [index, part] of plan.partitions.entries()) {
    const member = targets[index]!;
    c.usage.assists++;
    const work = discussionIntent(c, e, 'assistance', member.id);
    work.payload.question = part.objective;
    work.payload.expected = part.expectedOutput;
    work.payload.partition = structuredClone(part);
    work.payload.instructions = member.instructions;
  }
  message(c, e, 'facilitator', `已安排 ${plan.partitions.length} 个独立分片并行执行；全部结算后归并，再交回 ${c.owner}。`, 'notice');
  return true;
}
