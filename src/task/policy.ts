import { modelOutputIssues, type InputReference, type TaskContext, type TaskEvent } from '../types.js';
import { localAwaitingApproval, localEventProblem, localPhysicalPending, localUnsettled } from '../local-operation.js';
import { requestBudgetProblem } from './budget.js';
import { allInflight, discussionActive, fresh, hasOrdinary, incompatibleExecution, isBot, workLaneAvailable } from './facts.js';
import { validArtifactDrafts, validSummary } from '../presentation.js';
import { validInputIntent } from '../input-intent.js';
import { assistanceRetryProblem, helpProblem } from './assistance.js';
import { hostRetryProblem } from '../host-retry.js';

export function permissionProblem(c: TaskContext, e: TaskEvent): string | null {
  if (e.type.startsWith('LOCAL_')) return localEventProblem(c, e, work => requestBudgetProblem(c, work));
  if (e.type === 'REQUEST_HOST_RETRY') {
    if (!e.fence || !fresh(c, e)) return 'STALE_FENCE';
    if (!/^[a-f0-9]{64}$/.test(e.requestHash)) return 'INVALID_LOCAL_REQUEST';
    return hostRetryProblem(c, e.sourceWorkId, e.sourceOperationId, e.sourceRequestHash);
  }
  const attemptWorkId = e.workId ?? ('intentId' in e ? e.intentId : undefined);
  if (e.attempt !== undefined && c.intents.find(work => work.id === attemptWorkId)?.attempt !== e.attempt) return 'STALE_ATTEMPT';
  if (['DELIVER', 'CHECK_RESULT', 'RECORD_RESULT', 'DISCUSSION_PLAN', 'DISCUSSION_RESULT', 'COORDINATE', 'HELP', 'WAIT_USER', 'BLOCKED'].includes(e.type)
    && c.intents.some(work => (e.workId ? work.id === e.workId : !work.discussionId) && localUnsettled(work))) return 'LOCAL_OPERATION_PENDING';
  if (e.type === 'WORK_FAILED' && c.intents.some(work => work.id === e.intentId && localPhysicalPending(work))) return 'LOCAL_OPERATION_PENDING';
  if (e.type === 'SETTLE' && c.intents.some(work => work.id === e.intentId && localPhysicalPending(work))) return 'LOCAL_OPERATION_PENDING';
  if (e.type === 'RECONCILE' && c.intents.some(work => work.id === e.intentId && localPhysicalPending(work))) return 'LOCAL_OPERATION_PENDING';
  if (!fresh(c, e)) return 'STALE_FENCE';
  if (e.workId) {
    const op = c.intents.find(i => i.id === e.workId);
    if (!op || op.status !== 'inflight') return 'UNKNOWN_OR_SETTLED_WORK';
    if (op.epoch !== c.epoch || op.goalVersion !== c.goalVersion) return 'STALE_WORK';
    if (op.discussionId && !['DISCUSSION_PLAN', 'DISCUSSION_RESULT', 'WORK_FAILED'].includes(e.type)) return 'DISCUSSION_EVENT_REQUIRED';
  }
  if (c.stopped && !['STOP', 'SETTLE', 'HELP_RESULT', 'CONTINUE', 'RETRY_ASSISTANCE', 'RECOVER', 'CLAIM', 'WORK_FAILED', 'HUMAN_DECISION'].includes(e.type)) return 'STOPPED';
  if ((e.type === 'DELIVER' || e.type === 'RECORD_RESULT') && (!validArtifactDrafts(e.artifacts) || !validSummary(e.summary))) return 'INVALID_REPORT';
  switch (e.type) {
    case 'DISCUSSION_PLAN': case 'DISCUSSION_RESULT': {
      const work = c.intents.find(item => item.id === e.workId);
      if (!e.workId || !e.fence || !work?.discussionId) return 'DISCUSSION_WORK_REQUIRED';
      if (!discussionActive(c) || work.discussionId !== c.discussion!.id || e.discussionId !== work.discussionId) return 'STALE_DISCUSSION';
      if (work.deadline !== null && e.at >= work.deadline) return 'WORK_EXPIRED';
      if (e.type === 'DISCUSSION_PLAN') return work.kind === 'facilitator' && c.discussion!.status === 'planning'
        && e.decision?.action === 'review' && [e.decision.question, e.decision.expected, e.decision.reason].every(value => typeof value === 'string' && value.trim()) ? null : 'INVALID_DISCUSSION_PLAN';
      return ((work.kind === 'assistance' && c.discussion!.status === 'collecting') || (work.kind === 'discussionSummary' && c.discussion!.status === 'summarizing'))
        && typeof e.text === 'string' && !!e.text.trim() && ['success', 'partial', 'failed'].includes(e.status)
        && validSummary(e.summary) && validArtifactDrafts(e.artifacts) ? null : 'INVALID_DISCUSSION_RESULT';
    }
    case 'INTERPRETATION_RESULT': {
      const input = c.inputAnalyses?.find(input => input.id === e.inputId);
      const work = c.intents.find(work => work.id === e.workId);
      if (!input || input.status !== 'inflight' || input.workId !== e.workId || work?.kind !== 'interpretation') return 'UNKNOWN_INPUT_ANALYSIS';
      if (work.deadline !== null && e.at >= work.deadline) return 'WORK_EXPIRED';
      if (!validInputIntent(e.spec, input.action, work.payload.references as InputReference[])) return 'INVALID_INPUT_INTENT';
      return null;
    }
    case 'RETRY_ASSISTANCE': return assistanceRetryProblem(c, e.requestId, e.config);
    case 'HELP':
      if (c.assists.some(h => h.id === e.requestId)) return 'DUPLICATE_HELP';
      return helpProblem(c, e.caller, e.target, e.question, e.expected, e.requiredTools);
    case 'RECORD_RESULT':
    case 'HELP_RESULT': {
      if (e.type === 'HELP_RESULT' && (!validSummary(e.summary) || e.artifactIds?.some(id => !c.artifacts.some(a => a.id === id && a.goalVersion === c.goalVersion)))) return 'INVALID_REPORT';
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
      if (localAwaitingApproval(i)) return 'HOST_APPROVAL_REQUIRED';
      if (c.stopped) return 'STOPPED';
      if (i.epoch !== c.epoch || i.goalVersion !== c.goalVersion) return 'STALE_WORK';
      if (['owner', 'assistance', 'tool'].includes(i.kind) && !isBot(c, i.target)) return 'UNKNOWN_BOT';
      if (i.kind === 'assistance' && ((i.payload.requiredTools as string[] | undefined) ?? []).some(t => !c.config.bots.find(b => b.id === i.target)?.tools.includes(t))) return 'TOOL_PERMISSION';
      if (!workLaneAvailable(c, i)) return 'WORK_BUSY';
      if (i.deadline !== null && e.at >= i.deadline) return 'WORK_EXPIRED';
      if (i.kind === 'tool' && !c.config.bots.find(b => b.id === i.target)?.tools.includes(String(i.payload.tool))) return 'TOOL_PERMISSION';
      return requestBudgetProblem(c, i);
    }
    case 'REGENERATE_MODEL_OUTPUT': {
      const i = c.intents.find(i => i.id === e.intentId);
      if (!i || i.status !== 'inflight') return 'WORK_NOT_INFLIGHT';
      if (!['interpretation', 'owner', 'assistance', 'facilitator', 'discussionSummary', 'check'].includes(i.kind) || i.replay === 'unsafe') return 'OUTPUT_REPAIR_NOT_ALLOWED';
      if (i.epoch !== c.epoch || i.goalVersion !== c.goalVersion) return 'STALE_WORK';
      if (!modelOutputIssues.includes(e.issue)) return 'INVALID_OUTPUT_ISSUE';
      if (i.deadline !== null && e.at >= i.deadline) return 'WORK_EXPIRED';
      if (c.usage.retries >= c.config.limits.retries) return 'OUTPUT_REPAIR_EXHAUSTED';
      return requestBudgetProblem(c, i);
    }
    case 'CONSUME': {
      const i = c.intents.find(i => i.id === e.intentId);
      if (!i || i.status !== 'inflight' || i.bucket === 'none') return 'WORK_NOT_INFLIGHT';
      if (i.epoch !== c.epoch || i.goalVersion !== c.goalVersion) return 'STALE_WORK';
      if (i.deadline !== null && e.at >= i.deadline) return 'WORK_EXPIRED';
      if (e.capability) {
        if (!['owner', 'assistance', 'facilitator'].includes(i.kind)) return 'WEB_TOOLS_NOT_ALLOWED';
        if (c.config.webTools?.enabled === false) return 'WEB_TOOLS_DISABLED';
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
    case 'HANDOFF': return !isBot(c, e.owner) ? 'UNKNOWN_BOT' : allInflight(c).length || discussionActive(c) ? 'WAIT_FOR_BOUNDARY' : null;
    case 'CONTINUE': {
      if (incompatibleExecution(c)) return 'INCOMPATIBLE_EXECUTION';
      if (allInflight(c).length || c.intents.some(i => i.status === 'uncertain')) return 'UNRESOLVED_WORK';
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

export const valid = ({ context, event }: { context: TaskContext; event: TaskEvent }) => !permissionProblem(context, event);

export function localResumeKind(c: TaskContext, e: TaskEvent): string | null {
  if (!valid({ context: c, event: e }) || c.stopped || incompatibleExecution(c) || c.outcome !== null) return null;
  if (e.type !== 'LOCAL_RECONCILE' && e.type !== 'LOCAL_RESULT') return null;
  const work = c.intents.find(i => i.id === e.intentId);
  if (e.type === 'LOCAL_RESULT' && (work?.status !== 'uncertain' || !e.settled || !e.effectsKnown)) return null;
  if (!work || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return null;
  if (c.intents.some(i => i.localOperations?.some(op => op.id !== e.operationId && ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)))) return null;
  const primary = [...c.intents].reverse().find(i => !i.discussionId && i.kind !== 'cancel' && ['pending', 'inflight', 'uncertain'].includes(i.status));
  return primary?.kind ?? (discussionActive(c) ? 'owner' : null);
}
