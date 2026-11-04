import { type Assistance, type TaskContext, type TaskEvent } from '../types.js';
import { activeHelp, capabilities, fence, hasOrdinary, inflight, isBot } from './facts.js';
import { cancelWork, conversationInput, intent, message, owner, release, saveReports } from './operations.js';
import { modelSignature } from '../model-config.js';

export function helpProblem(c: TaskContext, caller: string, target: string, question: string, expected: string, requiredTools: string[] = []): string | null {
  if (caller !== c.owner) return 'NESTED_ASSISTANCE';
  if (target === c.owner) return 'SELF_DEPENDENCY';
  if (!isBot(c, target)) return 'UNKNOWN_BOT';
  if (requiredTools.some(tool => !c.config.bots.find(b => b.id === target)?.tools.includes(tool))) return 'TOOL_PERMISSION';
  if (!question.trim() || !expected.trim()) return 'INCOMPLETE_HELP';
  if (activeHelp(c)) return 'ASSISTANCE_BUSY';
  if (c.usage.assists >= c.config.limits.assists) return 'ASSISTANCE_LIMIT';
  if (!hasOrdinary(c)) return 'BUDGET_EXHAUSTED';
  return null;
}

export function startHelp(c: TaskContext, e: TaskEvent, id: string, target: string, question: string, expected: string, refs: string[], system: boolean, requiredTools: string[] = [], reviewId?: string, retryOf?: string) {
  cancelWork(c, e);
  const item: Assistance = { id, target, question, expected, refs, ...fence(c), status: 'pending', consumed: false,
    requestedBy: c.owner, requiredTools, ...(reviewId ? { reviewId } : {}), ...(retryOf ? { retryOf } : {}) };
  c.assists.push(item); c.usage.assists++;
  const reportRefs = new Set([...refs, ...(c.candidate?.artifactIds ?? []), ...c.assists.flatMap(help => help.artifactIds ?? [])]);
  intent(c, e.at, 'assistance', target, { requestId: id, question, expected, refs, requiredTools, goal: c.goal, board: c.board,
    artifacts: c.artifacts.filter(a => reportRefs.has(a.id)), ...conversationInput(c), instructions: c.config.bots.find(b => b.id === target)?.instructions ?? '', capabilities: capabilities(c) });
  message(c, e, system ? 'facilitator' : c.owner, system ? `已为 ${c.owner} 安排 ${target} 协助：${question}` : question, system ? 'notice' : 'help', { requestId: id, recipient: target });
  c.reason = `Waiting for ${target}: ${id}`;
}

export function savedHelpResult(c: TaskContext, requestId: string) {
  if (c.assists.find(h => h.id === requestId)?.status !== 'answered') return undefined;
  return c.results.find(r => r.requestId === requestId && !r.consumed && r.epoch === c.epoch && r.goalVersion === c.goalVersion);
}

export function helpTools(c: TaskContext, h: Assistance): string[] {
  return h.requiredTools ?? (c.intents.find(i => i.kind === 'assistance' && i.payload.requestId === h.id)?.payload.requiredTools as string[] | undefined) ?? [];
}

/** Shared command/snapshot guard; the machine rechecks it inside the transaction. */
export function assistanceRetryProblem(c: TaskContext, requestId: string, config = c.config): string | null {
  const h = c.assists.find(item => item.id === requestId);
  if (!h) return 'UNKNOWN_HELP';
  if (h.epoch !== c.epoch || h.goalVersion !== c.goalVersion) return 'STALE_HELP';
  if (c.assists.some(item => item.retryOf === h.id)) return 'ASSISTANCE_ALREADY_RETRIED';
  if (h.target === c.owner || (h.requestedBy && h.requestedBy !== c.owner)) return 'OWNER_CHANGED';
  if (h.reviewId && (h.reviewId !== c.review?.id || c.review.goalVersion !== c.goalVersion)) return 'STALE_REVIEW';
  if (c.outcome === 'complete') return 'TASK_COMPLETED';
  if (!['failed', 'timeout', 'partial', 'cancelled', 'answered'].includes(h.status)) return 'ASSISTANCE_NOT_RETRYABLE';
  if (inflight(c).length || c.intents.some(i => i.status === 'uncertain')) return 'UNRESOLVED_WORK';
  if (c.config.version !== config.version || c.config.toolVersion !== config.toolVersion
    || modelSignature(c.config.models) !== modelSignature(config.models)) return 'INCOMPATIBLE_EXECUTION';
  if (!config.bots.some(b => b.id === c.owner)) return 'OWNER_UNAVAILABLE';
  if (!config.bots.some(b => b.id === h.target)) return 'UNKNOWN_BOT';
  if (helpTools(c, h).some(tool => !config.bots.find(b => b.id === h.target)?.tools.includes(tool))) return 'TOOL_PERMISSION';
  if (activeHelp(c) && activeHelp(c)!.id !== h.id) return 'ASSISTANCE_BUSY';
  if (savedHelpResult(c, h.id)) return hasOrdinary(c) ? null : 'BUDGET_EXHAUSTED';
  if (h.status === 'answered') return 'RESULT_NOT_AVAILABLE';
  if (c.usage.retries >= c.config.limits.retries) return 'RETRY_LIMIT';
  if (c.usage.assists >= c.config.limits.assists) return 'ASSISTANCE_LIMIT';
  return c.config.limits.ordinary - c.usage.ordinary >= 2 ? null : 'ASSISTANCE_RESUME_BUDGET';
}

export function refreshReviewFailures(c: TaskContext) {
  const review = c.review!;
  delete review.incomplete;
  for (const target of review.completed) {
    const latest = c.assists.filter(h => h.reviewId === review.id && h.target === target).at(-1);
    if (latest && ['failed', 'timeout'].includes(latest.status)) review.incomplete = `成员 ${target} 未能完成评审：${latest.status}`;
  }
}

export function requestReview(c: TaskContext, id: string, request: string, targets: string[]) {
  c.review = { id: `review:${id}`, request, targets: [...new Set(targets)], completed: [], status: 'pending', ...fence(c) };
}

export function reviewCanDispatch(c: TaskContext) {
  // Keep one ordinary request for the owner's synthesis. Check capacity is separately reserved.
  return c.usage.ordinary + 1 < c.config.limits.ordinary && c.usage.assists < c.config.limits.assists;
}

export function nextReviewer(c: TaskContext, completing?: string) {
  return c.review?.targets.find(target => target !== completing && !c.review!.completed.includes(target));
}

export function helpResultContinuesReview(c: TaskContext, requestId: string) {
  if (c.inputs.some(n => !n.applied)) return false;
  const help = c.assists.find(h => h.id === requestId);
  const next = help ? nextReviewer(c, help.target) : undefined;
  return !!help?.reviewId && help.reviewId === c.review?.id && !!next && isBot(c, next) && reviewCanDispatch(c);
}

export function advanceReview(c: TaskContext, e: TaskEvent, completed?: Assistance) {
  const review = c.review!;
  if (completed) {
    if (!review.completed.includes(completed.target)) review.completed.push(completed.target);
    if (['failed', 'timeout'].includes(completed.status)) review.incomplete = `成员 ${completed.target} 未能完成评审：${completed.status}`;
  }
  const target = nextReviewer(c);
  if (target && reviewCanDispatch(c) && isBot(c, target)) {
    startHelp(c, e, `${review.id}:${target}:${c.nextSeq++}`, target, review.question!, review.expected!, [], true, [], review.id);
    return;
  }
  if (target) review.incomplete = `评审额度或成员不可用；尚未完成：${review.targets.filter(id => !review.completed.includes(id)).join('、')}`;
  review.status = 'summarizing';
  if (!hasOrdinary(c)) {
    const answers = c.assists.filter(h => h.reviewId === review.id && h.consumed).map(h => `${h.target}（${h.status}）：${h.answer ?? ''}`);
    c.candidate = { text: ['已收到的成员意见：', ...answers, review.incomplete ?? '执行额度不足，尚未完成汇总。'].join('\n\n'), artifactIds: [], goalVersion: c.goalVersion };
  }
  owner(c, e, { reason: '汇总本轮所有成员意见，区分共识、分歧、风险、建议与未完成项；不得再次索要已在群聊中的方案。' });
}

export function resetReviewAtBoundary(c: TaskContext, e: TaskEvent) {
  const review = c.review!;
  cancelWork(c, e);
  for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
  requestReview(c, e.id, review.request, review.targets);
}

export function acceptHelpResult(c: TaskContext, e: Extract<TaskEvent, { type: 'HELP_RESULT' }>) {
  const h = c.assists.find(h => h.id === e.requestId)!;
  const recorded = c.results.find(r => r.resultId === e.resultId);
  const summary = e.summary ?? recorded?.summary;
  const artifactIds = e.artifactIds ?? recorded?.artifactIds ?? saveReports(c, e, e.answer, h.target);
  h.status = e.status; h.resultId = e.resultId; h.answer = e.answer; h.consumed = true;
  h.artifactIds = artifactIds;
  if (summary !== undefined) h.summary = summary;
  c.consumedResults.push(e.resultId);
  if (recorded) recorded.consumed = true;
  for (const i of c.intents.filter(i => i.payload.requestId === h.id)) release(c, i.id);
  message(c, e, h.target, e.answer, 'answer', { requestId: h.id, artifactIds, ...(recorded?.workId ? { workId: recorded.workId } : {}) }, summary);
  const hasInputs = c.inputs.some(n => !n.applied);
  for (const note of c.inputs) note.applied = true;
  if (h.reviewId && h.reviewId === c.review?.id) {
    if (hasInputs) resetReviewAtBoundary(c, e);
    else advanceReview(c, e, h);
  } else {
    cancelWork(c, e);
    owner(c, e, { requestId: h.id, resultId: e.resultId, status: e.status, answer: e.answer, artifactIds, requiresAssessment: true });
    message(c, e, 'facilitator', `${h.target} 的核查结果已交给 ${c.owner}，已安排继续完善方案。`, 'notice', { requestId: h.id, recipient: c.owner });
  }
}
