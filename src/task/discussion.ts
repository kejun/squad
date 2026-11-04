import { type Decision, type Intent, type TaskContext, type TaskEvent } from '../types.js';
import { conversationInput, intent, message, release, saveReports } from './operations.js';
import { capabilities, discussionActive, fence } from './facts.js';

function discussionIntent(c: TaskContext, e: TaskEvent, kind: Intent['kind'], target: string) {
  const work = intent(c, e.at, kind, target, { goal: c.goal, board: c.board, artifacts: c.artifacts,
    ...conversationInput(c), roster: c.config.bots, capabilities: capabilities(c) });
  work.discussionId = c.discussion!.id;
  return work;
}

function discussionSources(c: TaskContext): string {
  const round = c.discussion!;
  return [
    ...round.results.map(result => `${result.target}（${result.status}）：${result.answer}`),
    ...round.skipped.map(item => `${item.target}：未参与（${item.reason}）`),
    round.incomplete ?? '',
  ].filter(Boolean).join('\n\n');
}

function discussionReady(c: TaskContext, e: TaskEvent, text: string) {
  c.discussion!.summary = text; c.discussion!.status = 'ready';
  message(c, e, 'facilitator', `讨论已汇总，等待 ${c.owner} 当前工作结算后继续完善方案。`, 'notice', { recipient: c.owner });
}

function summarizeDiscussion(c: TaskContext, e: TaskEvent) {
  c.discussion!.status = 'summarizing';
  discussionIntent(c, e, 'discussionSummary', 'facilitator');
}

export function startDiscussion(c: TaskContext, e: Extract<TaskEvent, { type: 'USER_INPUT' }>) {
  if (discussionActive(c)) {
    message(c, e, 'facilitator', '已在组织本轮讨论，结果将汇总交给原负责人。', 'notice');
    return;
  }
  const requested = [...new Set(e.reviewTargets!)];
  const busy = new Set(c.intents.filter(i => i.kind !== 'cancel' && ['pending', 'inflight', 'uncertain'].includes(i.status)).map(i => i.target));
  const skipped = requested.filter(target => busy.has(target)).map(target => ({ target, reason: '正在工作' }));
  c.discussion = { id: `discussion:${e.id}`, request: e.text, targets: requested.filter(target => !busy.has(target)),
    skipped, results: [], status: 'planning', ...fence(c) };
  const round = c.discussion;
  if (skipped.length) round.incomplete = '部分成员正在工作，本轮未参与讨论。';
  if (!round.targets.length || c.config.limits.ordinary - c.usage.ordinary < 4 || c.usage.assists >= c.config.limits.assists) {
    round.status = 'delivered';
    round.incomplete = !round.targets.length ? '暂无空闲成员参与讨论。' : '讨论额度不足，已保留原负责人续办额度。';
    if (round.targets.length) round.skipped.push(...round.targets.map(target => ({ target, reason: '讨论额度不足' })));
    message(c, e, 'facilitator', discussionSources(c), 'notice');
    return;
  }
  message(c, e, 'facilitator', `已收到讨论邀请，将组织空闲成员：${round.targets.join('、')}；结果汇总后交给 ${c.owner}。${skipped.length ? ` ${skipped.map(item => item.target).join('、')} 正在工作，本轮跳过。` : ''}`, 'notice');
  discussionIntent(c, e, 'facilitator', 'facilitator');
}

export function planDiscussion(c: TaskContext, e: Extract<TaskEvent, { type: 'DISCUSSION_PLAN' }>) {
  const round = c.discussion!;
  const decision = e.decision as Extract<Decision, { action: 'review' }>;
  release(c, e.workId);
  round.question = decision.question; round.expected = decision.expected; round.status = 'collecting';
  let capacity = Math.max(0, Math.min(c.config.limits.ordinary - c.usage.ordinary - 2, c.config.limits.assists - c.usage.assists));
  for (const target of round.targets) {
    const busy = c.intents.some(work => work.kind !== 'cancel' && work.target === target && ['pending', 'inflight', 'uncertain'].includes(work.status));
    if (busy || capacity <= 0) {
      round.skipped.push({ target, reason: busy ? '正在工作' : '讨论额度不足' });
      round.incomplete = '部分成员未参与讨论，详见未参与原因。';
      continue;
    }
    capacity--; c.usage.assists++;
    const work = discussionIntent(c, e, 'assistance', target);
    work.payload.question = decision.question; work.payload.expected = decision.expected;
    work.payload.instructions = c.config.bots.find(bot => bot.id === target)!.instructions;
  }
  if (!c.intents.some(work => work.discussionId === round.id && work.kind === 'assistance' && work.status === 'pending')) summarizeDiscussion(c, e);
}

export function discussionFailed(c: TaskContext, e: TaskEvent, work: Intent, reason: string) {
  release(c, work.id);
  const round = c.discussion!;
  round.incomplete = `讨论未全部完成：${reason}`;
  if (work.kind === 'assistance') {
    const status = /deadline|超时/i.test(reason) ? 'timeout' as const : 'failed' as const;
    round.results.push({ target: work.target, status, answer: reason, artifactIds: [] });
    message(c, e, work.target, `讨论${status === 'timeout' ? '超时' : '失败'}：${reason}`, 'answer');
    if (!c.intents.some(item => item.discussionId === round.id && item.kind === 'assistance' && ['pending', 'inflight'].includes(item.status))) summarizeDiscussion(c, e);
  } else discussionReady(c, e, discussionSources(c));
}

export function acceptDiscussion(c: TaskContext, e: Extract<TaskEvent, { type: 'DISCUSSION_RESULT' }>) {
  const work = c.intents.find(item => item.id === e.workId)!;
  release(c, work.id);
  const ids = saveReports(c, e, e.text, work.target, e.artifacts);
  if (e.status !== 'success') c.discussion!.incomplete = '部分讨论工作未完整完成，详见原始意见。';
  message(c, e, work.target, e.text, work.kind === 'discussionSummary' ? 'notice' : 'answer', { artifactIds: ids }, e.summary);
  if (work.kind === 'discussionSummary') discussionReady(c, e, e.text);
  else {
    c.discussion!.results.push({ target: work.target, status: e.status, answer: e.text, artifactIds: ids });
    if (!c.intents.some(item => item.discussionId === c.discussion!.id && item.kind === 'assistance' && ['pending', 'inflight'].includes(item.status))) summarizeDiscussion(c, e);
  }
}
