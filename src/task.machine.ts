import { assign, initialTransition, setup, transition, type SnapshotFrom } from 'xstate';
import type { Assistance, BoardEntry, Decision, Intent, Phase, TaskContext, TaskEvent, TaskInput } from './types.js';
import { modelSignature, resolveModel } from './model-config.js';

const ok = (c: TaskContext, detail = 'applied') => { c.reply = { ok: true, code: 'OK', detail }; };
const reject = (c: TaskContext, code: string) => { c.reply = { ok: false, code, detail: code }; };
const fence = (c: TaskContext) => ({ epoch: c.epoch, goalVersion: c.goalVersion });
const fresh = (c: TaskContext, e: TaskEvent) => !e.fence || (e.fence.epoch === c.epoch && e.fence.goalVersion === c.goalVersion);
const inflight = (c: TaskContext) => c.intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel');
const remainingInflight = (c: TaskContext, e: TaskEvent) => inflight(c).filter(i => i.id !== e.workId);
const activeHelp = (c: TaskContext) => c.assists.find(h => h.epoch === c.epoch && ['pending', 'running', 'answered'].includes(h.status));
const hasOrdinary = (c: TaskContext) => c.usage.ordinary < c.config.limits.ordinary;
const isBot = (c: TaskContext, id: string) => c.config.bots.some(b => b.id === id);
const capabilities = (c: TaskContext) => ({ findSkills: c.config.skillSearch?.enabled !== false,
  webSearch: c.config.webTools?.enabled !== false, webFetch: c.config.webTools?.enabled !== false });

function requestBudgetProblem(c: TaskContext, work: Intent): string | null {
  if (work.bucket === 'none') return null;
  if (c.usage[work.bucket] >= c.config.limits[work.bucket]) return 'BUDGET_EXHAUSTED';
  if (work.bucket === 'ordinary' && c.review && ['pending', 'reviewing'].includes(c.review.status)
    && c.usage.ordinary + 1 >= c.config.limits.ordinary) return 'REVIEW_SYNTHESIS_RESERVED';
  return null;
}
function canRetryWork(c: TaskContext, e: TaskEvent): boolean {
  if (e.type !== 'WORK_FAILED') return false;
  const work = c.intents.find(i => i.id === e.intentId);
  return !!work && e.transient && !e.resultUncertain && work.replay !== 'unsafe' && !c.stopped
    && c.usage.retries < c.config.limits.retries && hasOrdinary(c) && !requestBudgetProblem(c, work);
}

function message(c: TaskContext, e: TaskEvent, author: string, text: string, kind: TaskContext['messages'][number]['kind'], extra: Partial<TaskContext['messages'][number]> = {}) {
  c.messages.push({ id: `${c.taskId}:message:${c.nextSeq++}`, taskId: c.taskId, at: e.at, author, text, kind, ...extra });
}
function intent(c: TaskContext, at: number, kind: Intent['kind'], target: string, payload: Record<string, unknown> = {}, replay: Intent['replay'] = 'safe'): Intent {
  const item: Intent = { id: `${c.taskId}:E${c.epoch}:${kind}:${c.nextSeq++}`, kind, target, payload,
    ...fence(c), status: 'pending', replay, attempt: 0, deadline: at + c.config.limits.workTimeoutMs,
    bucket: kind === 'check' ? 'checks' : kind === 'cancel' ? 'none' : 'ordinary', requestCount: 0 };
  const model = resolveModel(c.config, kind, target);
  if (model) item.model = model;
  c.intents.push(item);
  return item;
}
function cancelWork(c: TaskContext, e: TaskEvent) {
  for (const item of [...c.intents]) {
    if (item.kind === 'cancel') continue;
    if (item.status === 'pending') item.status = 'cancelled';
    if (item.status === 'inflight' && !c.intents.some(i => i.kind === 'cancel' && i.payload.intentId === item.id && i.status !== 'cancelled')) {
      intent(c, e.at, 'cancel', item.target, { intentId: item.id });
    }
  }
}
function release(c: TaskContext, id: string | undefined) {
  if (!id) return;
  const work = c.intents.find(i => i.id === id);
  if (work) work.status = 'done';
  for (const cancel of c.intents.filter(i => i.kind === 'cancel' && i.payload.intentId === id)) cancel.status = 'done';
}
function conversationInput(c: TaskContext) {
  return { messages: [...(c.history?.messages ?? []), ...c.messages], candidate: c.candidate,
    conversation: { artifacts: c.history?.artifacts ?? [], board: c.history?.board ?? [], tasks: c.history?.tasks ?? [], truncated: c.history?.truncated ?? false },
    ...(c.review ? { review: { ...c.review, results: c.assists.filter(h => h.reviewId === c.review!.id).map(h => ({ target: h.target, requestId: h.id, status: h.status, answer: h.answer })) } } : {}) };
}
function owner(c: TaskContext, e: TaskEvent, payload: Record<string, unknown> = {}) {
  if (c.stopped) return;
  // Pending instructions are superseded, not executed in parallel.
  for (const i of c.intents) if (i.kind === 'owner' && i.status === 'pending') i.status = 'cancelled';
  intent(c, e.at, 'owner', c.owner, { ...payload, goal: c.goal, inputs: c.inputs.filter(n => n.applied),
    board: c.board, artifacts: c.artifacts, repeat: c.repeat, ...conversationInput(c),
    capabilities: capabilities(c), roster: c.config.bots.map(b => ({ id: b.id, name: b.name, instructions: b.instructions, tools: b.tools })) });
  c.nextCheckAt = e.at + c.config.limits.progressIntervalMs;
}
function coordinate(c: TaskContext, e: TaskEvent, reason: string) {
  cancelWork(c, e);
  c.reason = reason;
  c.deferredCoordination = false;
  intent(c, e.at, 'facilitator', 'facilitator', { reason, goal: c.goal, board: c.board, artifacts: c.artifacts,
    ...conversationInput(c), repeat: c.repeat, roster: c.config.bots, usage: c.usage, limits: c.config.limits, capabilities: capabilities(c) });
  c.nextCheckAt = e.at + c.config.limits.progressIntervalMs;
}
function helpProblem(c: TaskContext, caller: string, target: string, question: string, expected: string, requiredTools: string[] = []): string | null {
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
function startHelp(c: TaskContext, e: TaskEvent, id: string, target: string, question: string, expected: string, refs: string[], system: boolean, requiredTools: string[] = [], reviewId?: string) {
  cancelWork(c, e);
  const item: Assistance = { id, target, question, expected, refs, ...fence(c), status: 'pending', consumed: false, ...(reviewId ? { reviewId } : {}) };
  c.assists.push(item); c.usage.assists++;
  intent(c, e.at, 'assistance', target, { requestId: id, question, expected, refs, requiredTools, goal: c.goal, board: c.board,
    artifacts: c.artifacts.filter(a => refs.includes(a.id)), ...conversationInput(c), instructions: c.config.bots.find(b => b.id === target)?.instructions ?? '', capabilities: capabilities(c) });
  message(c, e, system ? 'facilitator' : c.owner, system ? `已为 ${c.owner} 安排 ${target} 协助：${question}` : question, system ? 'notice' : 'help', { requestId: id, recipient: target });
  c.reason = `Waiting for ${target}: ${id}`;
}
function requestReview(c: TaskContext, id: string, request: string, targets: string[]) {
  c.review = { id: `review:${id}`, request, targets: [...new Set(targets)], completed: [], status: 'pending', ...fence(c) };
}
function reviewCanDispatch(c: TaskContext) {
  // Keep one ordinary request for the owner's synthesis. Check capacity is separately reserved.
  return c.usage.ordinary + 1 < c.config.limits.ordinary && c.usage.assists < c.config.limits.assists;
}
function nextReviewer(c: TaskContext, completing?: string) {
  return c.review?.targets.find(target => target !== completing && !c.review!.completed.includes(target));
}
function advanceReview(c: TaskContext, e: TaskEvent, completed?: Assistance) {
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
function resetReviewAtBoundary(c: TaskContext, e: TaskEvent) {
  const review = c.review!;
  cancelWork(c, e);
  for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
  requestReview(c, e.id, review.request, review.targets);
}
function completeProblem(c: TaskContext): string | null {
  if (c.review && (c.review.incomplete || !['summarizing', 'complete'].includes(c.review.status))) return 'UNFINISHED_REVIEW';
  if (!c.candidate || !c.candidate.text.trim()) return 'NO_DELIVERY';
  if (c.candidate.goalVersion !== c.goalVersion) return 'STALE_DELIVERY';
  if (activeHelp(c)) return 'UNSETTLED_ASSISTANCE';
  const ids = new Set(c.candidate.artifactIds);
  if (ids.size < c.goal.requiredArtifacts) return 'MISSING_ARTIFACTS';
  for (const id of ids) {
    const artifact = c.artifacts.find(a => a.id === id);
    if (!artifact || !artifact.content.trim() || artifact.goalVersion !== c.goalVersion) return 'MISSING_OR_STALE_ARTIFACT';
  }
  return null;
}
function recoveryIssue(c: TaskContext, config: TaskContext['config']): string | null {
  if (c.config.version !== config.version || c.config.toolVersion !== config.toolVersion) return 'Execution version incompatible';
  if (modelSignature(c.config.models) !== modelSignature(config.models)) return 'Model configuration changed';
  if (!config.bots.some(b => b.id === c.owner)) return 'Execution member unavailable';
  if (c.review && ['pending', 'reviewing'].includes(c.review.status)
    && c.review.targets.some(target => !config.bots.some(bot => bot.id === target))) return 'Execution member unavailable';
  for (const i of c.intents.filter(i => ['pending', 'inflight'].includes(i.status))) {
    if (modelSignature(i.model) !== modelSignature(resolveModel(config, i.kind, i.target))) return 'Model configuration changed';
    if (['owner', 'assistance', 'tool'].includes(i.kind) && !config.bots.some(b => b.id === i.target)) return 'Execution member unavailable';
    const tools = config.bots.find(b => b.id === i.target)?.tools ?? [];
    if (i.kind === 'tool' && !tools.includes(String(i.payload.tool))) return 'Tool permission revoked';
    if (i.kind === 'assistance' && ((i.payload.requiredTools as string[] | undefined) ?? []).some(t => !tools.includes(t))) return 'Tool permission revoked';
  }
  return null;
}
function finish(c: TaskContext, e: TaskEvent, outcome: TaskContext['outcome'], reason: string) {
  cancelWork(c, e); c.outcome = outcome; c.reason = reason;
  if (c.review) c.review.status = outcome === 'stopped' ? 'cancelled' : 'complete';
  if (outcome !== 'stopped') message(c, e, c.owner, `${c.candidate?.text ?? ''}${reason ? `\n${reason}` : ''}`.trim(), 'final');
}
function permissionProblem(c: TaskContext, e: TaskEvent): string | null {
  if (!fresh(c, e)) return 'STALE_FENCE';
  if (e.workId) {
    const op = c.intents.find(i => i.id === e.workId);
    if (!op || op.status !== 'inflight') return 'UNKNOWN_OR_SETTLED_WORK';
    if (op.epoch !== c.epoch || op.goalVersion !== c.goalVersion) return 'STALE_WORK';
  }
  if (c.stopped && !['STOP', 'SETTLE', 'HELP_RESULT', 'CONTINUE', 'RECOVER', 'CLAIM', 'WORK_FAILED', 'HUMAN_DECISION'].includes(e.type)) return 'STOPPED';
  switch (e.type) {
    case 'HELP':
      if (c.assists.some(h => h.id === e.requestId)) return 'DUPLICATE_HELP';
      return helpProblem(c, e.caller, e.target, e.question, e.expected, e.requiredTools);
    case 'RECORD_RESULT':
    case 'HELP_RESULT': {
      if (c.consumedResults.includes(e.resultId)) return 'DUPLICATE_RESULT';
      const h = c.assists.find(i => i.id === e.requestId);
      if (!h || !['pending', 'running', 'answered'].includes(h.status)) return 'UNKNOWN_OR_SETTLED_HELP';
      if (e.type === 'RECORD_RESULT' && c.results.some(r => r.resultId === e.resultId)) return 'DUPLICATE_RESULT';
      if (h.epoch !== c.epoch || h.goalVersion !== c.goalVersion) return 'STALE_HELP';
      return null;
    }
    case 'COORDINATE': {
      const d = e.decision;
      if (!d || !['continue', 'assist', 'review', 'replan', 'askUser', 'finish'].includes(d.action) || typeof d.reason !== 'string' || !d.reason.trim()) return 'INVALID_DECISION';
      if (c.review?.status === 'pending' && !['review', 'askUser'].includes(d.action)) return 'REVIEW_PLAN_REQUIRED';
      if (d.action === 'review') {
        if (c.review?.status !== 'pending') return 'REVIEW_NOT_REQUESTED';
        if ([d.question, d.expected].some(value => typeof value !== 'string' || !value.trim())) return 'INVALID_DECISION';
        if (c.review.targets.some(target => target === c.owner || !isBot(c, target))) return 'INVALID_REVIEW_TARGET';
      }
      if (d.action === 'assist' && [d.target, d.question, d.expected].some(v => typeof v !== 'string')) return 'INVALID_DECISION';
      if (d.action === 'replan' && typeof d.plan !== 'string') return 'INVALID_DECISION';
      if (d.action === 'askUser' && typeof d.question !== 'string') return 'INVALID_DECISION';
      if (d.action === 'assist') return helpProblem(c, c.owner, d.target, d.question, d.expected);
      if (d.action === 'replan' && (c.usage.replans >= c.config.limits.replans || !d.plan?.trim())) return 'REPLAN_LIMIT_OR_INVALID_PLAN';
      if (d.action === 'askUser' && !d.question?.trim()) return 'MISSING_QUESTION';
      return null;
    }
    case 'CLAIM': {
      const i = c.intents.find(i => i.id === e.intentId);
      if (!i || i.status !== 'pending') return 'WORK_NOT_PENDING';
      if (i.kind === 'cancel') return null;
      if (c.stopped) return 'STOPPED';
      if (i.epoch !== c.epoch || i.goalVersion !== c.goalVersion) return 'STALE_WORK';
      if (['owner', 'assistance', 'tool'].includes(i.kind) && !isBot(c, i.target)) return 'UNKNOWN_BOT';
      if (i.kind === 'assistance' && ((i.payload.requiredTools as string[] | undefined) ?? []).some(t => !c.config.bots.find(b => b.id === i.target)?.tools.includes(t))) return 'TOOL_PERMISSION';
      if (inflight(c).length) return 'WORK_BUSY';
      if (i.deadline !== null && e.at >= i.deadline) return 'WORK_EXPIRED';
      if (i.kind === 'tool' && !c.config.bots.find(b => b.id === i.target)?.tools.includes(String(i.payload.tool))) return 'TOOL_PERMISSION';
      return requestBudgetProblem(c, i);
    }
    case 'CONSUME': {
      const i = c.intents.find(i => i.id === e.intentId);
      if (!i || i.status !== 'inflight' || i.bucket === 'none') return 'WORK_NOT_INFLIGHT';
      if (i.epoch !== c.epoch || i.goalVersion !== c.goalVersion) return 'STALE_WORK';
      if (e.capability) {
        if (!['owner', 'assistance', 'facilitator'].includes(i.kind)) return 'WEB_TOOLS_NOT_ALLOWED';
        if (c.config.webTools?.enabled === false) return 'WEB_TOOLS_DISABLED';
        if (i.deadline !== null && e.at >= i.deadline) return 'WORK_EXPIRED';
      }
      return i.requestCount > 0 ? requestBudgetProblem(c, i) : null;
    }
    case 'BOARD_WRITE': {
      if (e.author !== 'user' && !isBot(c, e.author)) return 'UNKNOWN_AUTHOR';
      const old = c.board.find(b => b.id === e.entryId);
      if (old && old.revision !== e.baseRevision) return 'REVISION_CONFLICT';
      if (old?.author === 'user' && e.author !== 'user') return 'HUMAN_AUTHORITY';
      if (e.kind === 'decision' && e.author !== 'user') return 'HUMAN_AUTHORITY';
      if (e.kind === 'evidence' && e.sources.length === 0) return 'MISSING_SOURCE';
      return null;
    }
    case 'USER_INPUT': case 'HUMAN_DECISION':
      return e.reviewTargets?.some(target => target === c.owner || !isBot(c, target)) ? 'INVALID_REVIEW_TARGET' : null;
    case 'HANDOFF': return !isBot(c, e.owner) ? 'UNKNOWN_BOT' : inflight(c).length ? 'WAIT_FOR_BOUNDARY' : null;
    case 'CONTINUE': {
      if (['Execution version incompatible', 'Tool permission revoked', 'Execution member unavailable', 'Model configuration changed'].includes(c.reason)) return 'INCOMPATIBLE_EXECUTION';
      if (inflight(c).length || c.intents.some(i => i.status === 'uncertain')) return 'UNRESOLVED_WORK';
      if (!isBot(c, c.owner)) return 'OWNER_UNAVAILABLE';
      if (e.extraOrdinary !== undefined && (!Number.isSafeInteger(e.extraOrdinary) || e.extraOrdinary <= 0)) return 'INVALID_BUDGET';
      return hasOrdinary(c) || e.extraOrdinary ? null : 'BUDGET_EXHAUSTED';
    }
    case 'TOOL': return c.config.bots.find(b => b.id === c.owner)?.tools.includes(e.tool) ? null : 'TOOL_PERMISSION';
    case 'PROGRESS': return e.refs.length && e.refs.some(ref => !c.progressRefs.includes(ref) && (c.artifacts.some(a => a.id === ref) || c.board.some(b => b.id === ref) || c.messages.some(m => m.id === ref))) ? null : 'MISSING_NEW_PROGRESS_EVIDENCE';
    case 'ARTIFACT': return c.artifacts.some(a => a.id === e.artifact.id) ? 'ARTIFACT_ID_CONFLICT' : null;
    case 'DELIVER': return e.text.trim() ? null : 'NO_DELIVERY';
    case 'CHECK_RESULT': return c.consumedResults.includes(e.resultId) ? 'DUPLICATE_RESULT' : null;
    case 'WORK_FAILED': {
      const work = c.intents.find(i => i.id === e.intentId);
      if (!work || !['pending', 'inflight'].includes(work.status)) return 'UNKNOWN_OR_SETTLED_WORK';
      if (work.kind !== 'cancel' && (work.epoch !== c.epoch || work.goalVersion !== c.goalVersion)) return 'STALE_WORK';
      return null;
    }
    case 'RECONCILE': return c.intents.find(i => i.id === e.intentId)?.status === 'uncertain' ? null : 'NOT_UNCERTAIN';
    default: return null;
  }
}

function reduce(original: TaskContext, e: TaskEvent): TaskContext {
  const c = structuredClone(original);
  const problem = permissionProblem(c, e);
  if (problem) { reject(c, problem); return c; }
  if (['HELP', 'HELP_RESULT', 'RECORD_RESULT', 'COORDINATE', 'BLOCKED', 'WAIT_USER', 'DELIVER', 'CHECK_RESULT', 'TOOL', 'SETTLE'].includes(e.type)) release(c, e.workId);
  ok(c); c.lastActivityAt = e.at;
  c.trace.push({ event: e.type, detail: e.id, at: e.at });
  switch (e.type) {
    case 'HELP': startHelp(c, e, e.requestId, e.target, e.question, e.expected, e.refs ?? [], false, e.requiredTools); break;
    case 'RECORD_RESULT': {
      const h = c.assists.find(h => h.id === e.requestId)!;
      h.status = 'answered';
      c.results.push({ requestId: e.requestId, resultId: e.resultId, status: e.status, answer: e.answer, consumed: false, ...fence(c) });
      break;
    }
    case 'HELP_RESULT': {
      const h = c.assists.find(h => h.id === e.requestId)!;
      h.status = e.status; h.resultId = e.resultId; h.answer = e.answer; h.consumed = true;
      c.consumedResults.push(e.resultId);
      const recorded = c.results.find(r => r.resultId === e.resultId);
      if (recorded) recorded.consumed = true;
      for (const i of c.intents.filter(i => i.payload.requestId === h.id)) release(c, i.id);
      message(c, e, h.target, e.answer, 'answer', { requestId: h.id });
      if (h.reviewId && h.reviewId === c.review?.id) advanceReview(c, e, h);
      else owner(c, e, { requestId: h.id, resultId: e.resultId, status: e.status, answer: e.answer, requiresAssessment: true });
      break;
    }
    case 'BLOCKED':
      if (inflight(c).length) { c.deferredCoordination = true; c.reason = e.reason; }
      else coordinate(c, e, e.reason);
      break;
    case 'COORDINATE': {
      const d: Decision = e.decision;
      c.trace.push({ event: 'COORDINATION_DECISION', at: e.at, detail: JSON.stringify({ decision: d,
        basis: { reason: c.reason, ...fence(c), boardRefs: c.board.map(entry => entry.id), artifactRefs: c.artifacts.map(artifact => artifact.id), repeat: c.repeat } }) });
      if (d.action === 'review') {
        c.review!.status = 'reviewing'; c.review!.question = d.question; c.review!.expected = d.expected;
        advanceReview(c, e);
      }
      if (d.action === 'continue') owner(c, e, { reason: d.reason });
      if (d.action === 'assist') startHelp(c, e, `${c.taskId}:help:${c.nextSeq++}`, d.target, d.question, d.expected, [], true);
      if (d.action === 'replan') {
        c.usage.replans++;
        c.board.push({ id: `${c.taskId}:plan:${c.usage.replans}`, kind: 'opinion', author: 'facilitator', text: d.plan, sources: [], verified: false, revision: 1, goalVersion: c.goalVersion });
        owner(c, e, { plan: d.plan, retainedEvidence: c.board.map(b => b.id), reason: d.reason });
      }
      if (d.action === 'askUser') { cancelWork(c, e); c.reason = d.question; message(c, e, 'facilitator', d.question, 'notice'); }
      if (d.action === 'finish') finish(c, e, c.artifacts.length || c.candidate ? 'partial' : 'failed', d.reason);
      break;
    }
    case 'WAIT_USER': cancelWork(c, e); c.reason = e.question; message(c, e, c.owner, e.question, 'answer'); break;
    case 'USER_INPUT': {
      if (e.history) c.history = e.history;
      message(c, e, 'user', e.text, 'user');
      if (e.decision) c.board.push({ id: e.id, kind: 'decision', text: e.text, author: 'user', sources: [], verified: false, revision: 1, goalVersion: c.goalVersion });
      else {
        c.inputs.push({ id: e.id, text: e.text, applied: false });
        if (e.goal) {
          c.goal = e.goal; c.goalVersion++; c.candidate = null;
          cancelWork(c, e);
          for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        }
      }
      if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
      break;
    }
    case 'HUMAN_DECISION': {
      if (e.history) c.history = e.history;
      message(c, e, 'user', e.text, 'user');
      c.board.push({ id: e.id, kind: 'decision', text: e.text, author: 'user', sources: [e.id], verified: false, revision: 1, goalVersion: c.goalVersion });
      if (c.outcome === null) {
        c.goal.constraints.push(`用户决定：${e.text}`); c.goalVersion++; c.candidate = null;
        c.inputs.push({ id: e.id, text: e.text, applied: false }); cancelWork(c, e);
        for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
      }
      break;
    }
    case 'BOUNDARY':
      for (const note of c.inputs) note.applied = true;
      if (c.review && !['cancelled', 'complete'].includes(c.review.status)) resetReviewAtBoundary(c, e);
      else owner(c, e, { reason: 'Apply latest user input' });
      c.deferredCoordination = false; break;
    case 'HANDOFF': {
      const from = c.owner;
      cancelWork(c, e); c.owner = e.owner;
      c.trace.push({ event: 'OWNERSHIP_HANDOFF', at: e.at, detail: JSON.stringify({ from, to: e.owner, ...fence(c),
        boardRefs: c.board.map(entry => entry.id), artifactRefs: c.artifacts.map(artifact => artifact.id) }) });
      message(c, e, 'facilitator', `任务从 ${from} 交接给 ${e.owner}`, 'notice');
      owner(c, e, { handoff: true, boardRefs: c.board.map(b => b.id) }); break;
    }
    case 'DELIVER':
      cancelWork(c, e); c.candidate = { text: e.text, artifactIds: e.artifactIds, goalVersion: c.goalVersion };
      intent(c, e.at, 'check', 'facilitator', { goal: c.goal, artifacts: c.artifacts, board: c.board, ...conversationInput(c), deterministicGap: completeProblem(c) });
      break;
    case 'CHECK_RESULT':
      c.consumedResults.push(e.resultId);
      if (c.review?.incomplete) finish(c, e, 'partial', c.review.incomplete);
      else if (e.passed && !completeProblem(c)) finish(c, e, 'complete', '');
      else if (hasOrdinary(c)) coordinate(c, e, [completeProblem(c), ...e.gaps].filter(Boolean).join('; ') || 'Incomplete delivery');
      else finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed', e.gaps.join('; ') || completeProblem(c) || 'Budget exhausted');
      break;
    case 'STOP':
      c.stopped = true; c.reason = 'User requested stop'; cancelWork(c, e);
      if (c.review) c.review.status = 'cancelled';
      for (const h of c.assists) if (['pending', 'running', 'answered'].includes(h.status)) h.status = 'cancelled';
      break;
    case 'SETTLE': {
      const work = c.intents.find(i => i.id === e.intentId);
      release(c, e.intentId);
      if (work?.kind === 'tool' && !c.stopped && fresh(c, { ...e, fence: { epoch: work.epoch, goalVersion: work.goalVersion } })) owner(c, e, { toolResult: work.id });
      break;
    }
    case 'CONTINUE':
      if (e.extraOrdinary) c.config.limits.ordinary += e.extraOrdinary;
      c.epoch++; c.stopped = false; c.outcome = null; c.reason = '';
      for (const h of c.assists) if (['pending', 'running', 'answered'].includes(h.status)) h.status = 'cancelled';
      if (c.review && (c.review.status !== 'complete' || c.review.incomplete)) {
        requestReview(c, e.id, c.review.request, c.review.targets); c.candidate = null;
      } else owner(c, e, { continued: true });
      break;
    case 'TICK': c.processedSignals.push(e.id); coordinate(c, e, 'No evidenced progress by deadline'); break;
    case 'ACTIVITY': break;
    case 'PROGRESS': c.progressRefs.push(...e.refs); c.lastProgressAt = e.at; c.nextCheckAt = e.at + c.config.limits.progressIntervalMs; c.repeat.count = 0; break;
    case 'FAILURE_SIGNAL': {
      const fingerprint = JSON.stringify([e.operation, e.parameters, e.resource, e.error, e.result]).normalize('NFKC');
      c.repeat = { fingerprint, count: c.repeat.fingerprint === fingerprint ? c.repeat.count + 1 : 1 };
      if (c.repeat.count >= c.config.limits.repeatThreshold) {
        if (inflight(c).length) { c.deferredCoordination = true; c.reason = 'Repeated failure without progress'; }
        else coordinate(c, e, 'Repeated failure without progress');
      }
      break;
    }
    case 'BOARD_WRITE': {
      const old = c.board.find(b => b.id === e.entryId);
      const item: BoardEntry = { id: e.entryId, revision: (old?.revision ?? 0) + 1, author: e.author, text: e.text, kind: e.kind, sources: e.sources, verified: false, goalVersion: c.goalVersion };
      if (old) { c.boardHistory.push(old); c.board[c.board.indexOf(old)] = item; } else c.board.push(item);
      break;
    }
    case 'ARTIFACT': c.artifacts.push({ ...e.artifact, goalVersion: c.goalVersion }); c.progressRefs.push(e.artifact.id); c.repeat.count = 0; c.lastProgressAt = e.at; c.nextCheckAt = e.at + c.config.limits.progressIntervalMs; break;
    case 'CLAIM': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      work.status = 'inflight'; work.attempt++; work.requestCount = 0;
      if (work.bucket !== 'none') c.usage[work.bucket]++;
      if (work.kind === 'assistance') c.assists.find(h => h.id === work.payload.requestId)!.status = 'running';
      break;
    }
    case 'CONSUME': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      if (work.requestCount > 0 && work.bucket !== 'none') c.usage[work.bucket]++;
      work.requestCount++;
      break;
    }
    case 'WORK_FAILED': {
      const work = c.intents.find(i => i.id === e.intentId);
      if (!work) { reject(c, 'UNKNOWN_WORK'); break; }
      if (work.kind === 'cancel') { work.status = 'done'; c.reason = `Cancellation not confirmed: ${e.reason}`; break; }
      if (e.resultUncertain || work.replay === 'unsafe') {
        work.status = 'uncertain'; c.reason = `Result uncertain; reconcile before retry: ${e.reason}`;
      } else if (canRetryWork(c, e)) {
        c.usage.retries++; work.status = 'pending'; work.deadline = e.at + c.config.limits.workTimeoutMs;
      } else {
        const failureReason = e.transient && c.usage.retries >= c.config.limits.retries ? `${e.reason}（重试额度已用尽）` : e.reason;
        release(c, work.id); c.reason = failureReason;
        if (work.kind === 'assistance') {
          const h = c.assists.find(h => h.id === work.payload.requestId)!;
          h.status = 'failed'; h.answer = failureReason; h.consumed = true;
          message(c, e, h.target, failureReason, 'answer', { requestId: h.id });
          if (h.reviewId && h.reviewId === c.review?.id) advanceReview(c, e, h);
          else owner(c, e, { requestId: h.id, status: 'failed', answer: failureReason });
        }
      }
      break;
    }
    case 'RECOVER': {
      const issue = recoveryIssue(c, e.config);
      c.config.bots = e.config.bots; // Current permissions always win.
      c.config.skillSearch = { enabled: e.config.skillSearch?.enabled !== false };
      c.config.webTools = { enabled: e.config.webTools?.enabled !== false };
      for (const work of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && ['owner', 'assistance', 'facilitator'].includes(i.kind))) work.payload.capabilities = capabilities(c);
      if (issue) { cancelWork(c, e); c.reason = issue; reject(c, 'INCOMPATIBLE_EXECUTION'); break; }
      for (const work of c.intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel')) {
        if (work.replay === 'unsafe') { work.status = 'uncertain'; c.reason = 'Reconcile uncertain external result'; }
        else { work.status = 'pending'; }
      }
      break;
    }
    case 'TOOL':
      cancelWork(c, e); intent(c, e.at, 'tool', c.owner, { tool: e.tool, ...e.payload }, e.replay); break;
    case 'EXHAUSTED': finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed', e.reason); break;
    case 'RECONCILE': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      work.status = 'done';
      c.trace.push({ event: 'RECONCILED', detail: `${work.id}:${e.resolution}:${e.detail}`, at: e.at });
      c.reason = 'External result reconciled; waiting for explicit continuation';
      break;
    }
  }
  return c;
}

const valid = ({ context, event }: { context: TaskContext; event: TaskEvent }) => !permissionProblem(context, event);
const d = (event: TaskEvent) => event.type === 'COORDINATE' ? event.decision : null;

export const taskMachine = setup({
  types: { context: {} as TaskContext, events: {} as TaskEvent, input: {} as TaskInput },
  actions: {
    apply: assign(({ context, event }) => reduce(context, event)),
    reject: assign(({ context, event }) => {
      const c = structuredClone(context); reject(c, permissionProblem(c, event) ?? 'INVALID_STATE');
      // A stale completion may retire its own physical work, never advance the new round.
      const physicalWorkId = event.workId ?? (event.type === 'WORK_FAILED' ? event.intentId : undefined);
      const work = context.intents.find(i => i.id === physicalWorkId);
      if (work && (!event.fence || (event.fence.epoch === work.epoch && event.fence.goalVersion === work.goalVersion))) release(c, work.id);
      if (['HELP_RESULT', 'RECORD_RESULT', 'DELIVER', 'CHECK_RESULT', 'COORDINATE', 'WORK_FAILED', 'BLOCKED'].includes(event.type)) c.lateResults.push(event);
      if (event.type === 'HELP_RESULT') { const r = c.results.find(r => r.resultId === event.resultId); if (r) r.consumed = true; }
      if (event.type === 'COORDINATE' && fresh(context, event) && !context.stopped && ['INVALID_DECISION', 'REVIEW_PLAN_REQUIRED', 'REVIEW_NOT_REQUESTED'].includes(c.reply.code)) {
        cancelWork(c, event); c.reason = 'Facilitator judgment invalid; human input required';
        message(c, event, 'facilitator', c.reason, 'notice');
      }
      c.trace.push({ event: 'REJECTED', detail: `${event.id}:${c.reply.code}`, at: event.at });
      return c;
    }),
    boundary: assign(({ context, event }) => {
      const next = reduce(context, { id: `${event.id}:boundary`, at: event.at, type: 'BOUNDARY' });
      next.reply = context.reply; // An internal transition must not overwrite the initiating command's rejection.
      return next;
    }),
    stopped: assign(({ context }) => ({ outcome: 'stopped' as const, reason: context.reason || 'Stopped' })),
    deferred: assign(({ context, event }) => {
      const c = structuredClone(context); coordinate(c, event, c.reason); return c;
    }),
    beginReview: assign(({ context, event }) => {
      const c = structuredClone(context);
      // The initial XState transition has no event timestamp; retain the persisted input clock.
      coordinate(c, { type: 'BOUNDARY', id: event.id ?? 'initial-review', at: event.at ?? c.lastActivityAt }, `用户请求成员评审：${c.review!.request}`);
      return c;
    }),
  },
  guards: {
    valid,
    safeBoundary: ({ context }) => inflight(context).length === 0,
    inputsReady: ({ context }) => !context.stopped && context.outcome === null && context.inputs.some(n => !n.applied) && inflight(context).length === 0,
    stoppedSettled: ({ context }) => context.stopped && inflight(context).length === 0 && !context.intents.some(i => i.status === 'uncertain'),
    canCoordinate: args => valid(args) && remainingInflight(args.context, args.event).length === 0,
    isCurrent: ({ context, event }) => fresh(context, event) && !context.stopped && (!event.workId || context.intents.some(i => i.id === event.workId && i.status === 'inflight')),
    deferredReady: ({ context }) => context.deferredCoordination && inflight(context).length === 0,
    reviewReady: ({ context }) => context.review?.status === 'pending' && !context.stopped && inflight(context).length === 0,
    decisionReview: args => valid(args) && d(args.event)?.action === 'review',
    decisionReviewDispatch: args => valid(args) && d(args.event)?.action === 'review' && reviewCanDispatch(args.context),
    reviewResultContinues: args => {
      if (!valid(args) || args.event.type !== 'HELP_RESULT') return false;
      const event = args.event;
      const help = args.context.assists.find(h => h.id === event.requestId);
      const next = help ? nextReviewer(args.context, help.target) : undefined;
      return !!help?.reviewId && help.reviewId === args.context.review?.id && !!next && isBot(args.context, next) && reviewCanDispatch(args.context);
    },
    failedReviewContinues: args => {
      if (!valid(args) || args.event.type !== 'WORK_FAILED' || args.event.resultUncertain) return false;
      const event = args.event;
      const work = args.context.intents.find(i => i.id === event.intentId);
      const help = args.context.assists.find(h => h.id === work?.payload.requestId);
      const next = help ? nextReviewer(args.context, help.target) : undefined;
      return work?.kind === 'assistance' && !!help?.reviewId && help.reviewId === args.context.review?.id
        && !!next && isBot(args.context, next) && reviewCanDispatch(args.context);
    },
    incompleteReview: args => valid(args) && !!args.context.review?.incomplete,
    claimOwner: args => valid(args) && ['owner', 'tool'].includes(args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind ?? ''),
    claimHelp: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'assistance',
    claimFacilitator: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'facilitator',
    claimCheck: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'check',
    claimCancel: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'cancel',
    shouldTick: ({ context, event }) => valid({ context, event }) && event.at >= context.nextCheckAt && inflight(context).length === 0 && !context.processedSignals.includes(event.id),
    repeated: ({ context, event }) => {
      if (event.type !== 'FAILURE_SIGNAL' || !valid({ context, event }) || remainingInflight(context, event).length) return false;
      const f = JSON.stringify([event.operation, event.parameters, event.resource, event.error, event.result]).normalize('NFKC');
      return (f === context.repeat.fingerprint ? context.repeat.count + 1 : 1) >= context.config.limits.repeatThreshold;
    },
    decisionAssist: args => valid(args) && d(args.event)?.action === 'assist',
    decisionAsk: args => valid(args) && d(args.event)?.action === 'askUser',
    decisionFinish: args => valid(args) && d(args.event)?.action === 'finish',
    decisionRun: args => valid(args) && ['continue', 'replan'].includes(d(args.event)?.action ?? ''),
    checkComplete: ({ context, event }) => valid({ context, event }) && event.type === 'CHECK_RESULT' && event.passed && !completeProblem(context),
    canCorrect: ({ context, event }) => valid({ context, event }) && hasOrdinary(context),
    retryable: args => valid(args) && canRetryWork(args.context, args.event),
    failedAssistance: args => valid(args) && args.event.type === 'WORK_FAILED' && !args.event.resultUncertain && args.context.intents.find(i => i.id === (args.event as Extract<TaskEvent, { type: 'WORK_FAILED' }>).intentId)?.kind === 'assistance',
    recoveredSafe: ({ context, event }) => event.type === 'RECOVER' && !recoveryIssue(context, event.config) && !context.intents.some(i => i.status === 'inflight' && i.replay === 'unsafe'),
  },
}).createMachine({
  id: 'botTeamTask', initial: 'running',
  context: ({ input }) => {
    const c: TaskContext = { schemaVersion: 1, taskId: input.taskId, owner: input.owner, config: structuredClone(input.config), goal: structuredClone(input.goal),
      epoch: 1, goalVersion: 1, messages: [input.message], board: [], boardHistory: [], artifacts: [], assists: [], intents: [], trace: [], inputs: [], consumedResults: [], processedSignals: [], progressRefs: [], lateResults: [], results: [],
      usage: { ordinary: 0, checks: 0, assists: 0, replans: 0, retries: 0 }, candidate: null, outcome: null, reason: '', stopped: false, nextSeq: 1,
      lastActivityAt: input.at, lastProgressAt: input.at, nextCheckAt: input.at + input.config.limits.progressIntervalMs, repeat: { fingerprint: '', count: 0 }, deferredCoordination: false, reply: { ok: true, code: 'OK', detail: 'created' } };
    if (input.history) c.history = input.history;
    if (input.reviewTargets?.length) requestReview(c, input.message.id, input.message.text, input.reviewTargets);
    else owner(c, { type: 'BOUNDARY', id: 'initial', at: input.at });
    return c;
  },
  always: { guard: 'inputsReady', target: '.running', actions: 'boundary' },
  on: {
    STOP: { guard: 'valid', target: '.stopping', actions: 'apply' },
    USER_INPUT: { guard: 'valid', actions: 'apply' },
    HUMAN_DECISION: { guard: 'valid', actions: 'apply' },
    BOARD_WRITE: { guard: 'valid', actions: 'apply' },
    ARTIFACT: { guard: 'valid', actions: 'apply' },
    ACTIVITY: { guard: 'valid', actions: 'apply' },
    PROGRESS: { guard: 'valid', actions: 'apply' },
    CLAIM: { guard: 'claimCancel', actions: 'apply' },
    CONSUME: { guard: 'valid', actions: 'apply' },
    SETTLE: { guard: 'valid', actions: 'apply' },
    RECOVER: [{ guard: 'recoveredSafe', actions: 'apply' }, { target: '.waitingHuman', actions: 'apply' }],
    EXHAUSTED: { guard: 'valid', target: '.ended', actions: 'apply' },
    RECONCILE: { guard: 'valid', actions: 'apply' },
    '*': { actions: 'reject' },
  },
  states: {
    running: {
      always: [{ guard: 'reviewReady', target: 'coordinating', actions: 'beginReview' }, { guard: 'deferredReady', target: 'coordinating', actions: 'deferred' }],
      on: {
        CLAIM: { guard: 'claimOwner', actions: 'apply' },
        HELP: { guard: 'valid', target: 'waitingAssistance', actions: 'apply' },
        BLOCKED: [{ guard: 'canCoordinate', target: 'coordinating', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
        WAIT_USER: { guard: 'valid', target: 'waitingHuman', actions: 'apply' },
        HANDOFF: { guard: 'valid', actions: 'apply' },
        DELIVER: { guard: 'valid', target: 'checking', actions: 'apply' },
        TOOL: { guard: 'valid', actions: 'apply' },
        TICK: { guard: 'shouldTick', target: 'coordinating', actions: 'apply' },
        FAILURE_SIGNAL: [{ guard: 'repeated', target: 'coordinating', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
        WORK_FAILED: [{ guard: 'retryable', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    waitingAssistance: {
      on: {
        CLAIM: { guard: 'claimHelp', actions: 'apply' },
        RECORD_RESULT: { guard: 'valid', actions: 'apply' },
        HELP_RESULT: [{ guard: 'reviewResultContinues', actions: 'apply' }, { guard: 'valid', target: 'running', actions: 'apply' }],
        WORK_FAILED: [{ guard: 'retryable', actions: 'apply' }, { guard: 'failedReviewContinues', actions: 'apply' }, { guard: 'failedAssistance', target: 'running', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    coordinating: {
      on: {
        CLAIM: { guard: 'claimFacilitator', actions: 'apply' },
        COORDINATE: [
          { guard: 'decisionReviewDispatch', target: 'waitingAssistance', actions: 'apply' },
          { guard: 'decisionReview', target: 'running', actions: 'apply' },
          { guard: 'decisionAssist', target: 'waitingAssistance', actions: 'apply' },
          { guard: 'decisionAsk', target: 'waitingHuman', actions: 'apply' },
          { guard: 'decisionFinish', target: 'ended', actions: 'apply' },
          { guard: 'decisionRun', target: 'running', actions: 'apply' },
          { guard: 'isCurrent', target: 'waitingHuman', actions: 'reject' },
        ],
        WORK_FAILED: [{ guard: 'retryable', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    waitingHuman: { on: { CONTINUE: { guard: 'valid', target: 'running', actions: 'apply' } } },
    checking: {
      on: {
        CLAIM: { guard: 'claimCheck', actions: 'apply' },
        CHECK_RESULT: [
          { guard: 'incompleteReview', target: 'ended', actions: 'apply' },
          { guard: 'checkComplete', target: 'ended', actions: 'apply' },
          { guard: 'canCorrect', target: 'coordinating', actions: 'apply' },
          { guard: 'valid', target: 'ended', actions: 'apply' },
        ],
        WORK_FAILED: [{ guard: 'retryable', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    stopping: {
      always: { guard: 'stoppedSettled', target: 'ended', actions: 'stopped' },
      on: { STOP: {}, WORK_FAILED: { actions: 'apply' }, HELP_RESULT: { actions: 'reject' }, SETTLE: { actions: 'apply' } },
    },
    ended: {
      on: {
        STOP: {}, CONTINUE: { guard: 'valid', target: 'running', actions: 'apply' },
        USER_INPUT: { actions: 'reject' }, ARTIFACT: { actions: 'reject' }, PROGRESS: { actions: 'reject' },
        RECOVER: { actions: 'apply' }, CLAIM: { actions: 'reject' }, CONSUME: { actions: 'reject' },
      },
    },
  },
});

export type TaskSnapshot = SnapshotFrom<typeof taskMachine>;
export function initialTask(input: TaskInput): TaskSnapshot { return initialTransition(taskMachine, input)[0]; }
export function stepTask(snapshot: TaskSnapshot, event: TaskEvent): TaskSnapshot { return transition(taskMachine, snapshot, event)[0]; }
export function persistTask(snapshot: TaskSnapshot): unknown { return taskMachine.getPersistedSnapshot(snapshot); }
export function restoreTask(value: unknown): TaskSnapshot { return taskMachine.restoreSnapshot(value as Parameters<typeof taskMachine.restoreSnapshot>[0], {} as never); }
export function taskPhase(snapshot: TaskSnapshot): Phase { return snapshot.value as Phase; }
