import { failHostRetryBoundary, startHostRetryBatch } from '../host-retry.js';
import { type TaskContext, type TaskEvent } from '../types.js';
import { assign } from 'xstate';
import { reduce } from './reducer.js';
import { discussionActive, fresh, reject } from './facts.js';
import { permissionProblem } from './policy.js';
import { discussionFailed } from './discussion.js';
import { cancelWork, coordinate, message, release } from './operations.js';
import { prepareInterpretation } from './input.js';

// The root machine remains the sole owner of the context returned by each pure action.
const taskAssign = assign<TaskContext, TaskEvent, undefined, TaskEvent, never>;
const coordinationProblems: Record<string, string> = {
  SELF_DEPENDENCY: '协调员不能向当前负责人本人请求协助',
  UNKNOWN_BOT: '指定的协助成员不存在',
  INVALID_DECISION: '协调员返回的决策不符合要求',
  REVIEW_PLAN_REQUIRED: '当前成员评审需要先给出评审安排',
  REVIEW_NOT_REQUESTED: '当前任务没有待安排的成员评审',
  INVALID_REVIEW_TARGET: '评审名单包含无效成员或当前负责人',
  INCOMPLETE_HELP: '协助问题或预期结果不完整',
  ASSISTANCE_BUSY: '当前协助尚未结束',
  ASSISTANCE_LIMIT: '协助次数已用尽',
  BUDGET_EXHAUSTED: '执行请求额度已用尽',
  REPLAN_LIMIT_OR_INVALID_PLAN: '重新规划额度已用尽或计划内容无效',
  MISSING_QUESTION: '缺少需要用户回答的问题',
};

export const taskActions = {
    apply: taskAssign(({ context, event }) => reduce(context, event)),
    failCheckClaim: taskAssign(({ context, event }) => {
      if (event.type !== 'CLAIM') return {};
      const code = permissionProblem(context, event)!;
      const c = reduce(context, { ...event, type: 'WORK_FAILED', transient: false, reason: code });
      reject(c, code);
      return c;
    }),
    startHostRetry: taskAssign(({ context, event }) => {
      const c = structuredClone(context);
      startHostRetryBatch(c, { ...event, at: event.at ?? c.lastActivityAt });
      return c;
    }),
    failHostRetry: taskAssign(({ context, event }) => {
      const c = structuredClone(context);
      failHostRetryBoundary(c, { ...event, at: event.at ?? c.lastActivityAt });
      return c;
    }),
    reject: taskAssign(({ context, event }) => {
      const c = structuredClone(context); reject(c, permissionProblem(c, event) ?? 'INVALID_STATE');
      // A stale completion may retire its own physical work, never advance the new round.
      const physicalWorkId = event.type.startsWith('LOCAL_') ? undefined : event.workId ?? (event.type === 'WORK_FAILED' ? event.intentId : undefined);
      const work = context.intents.find(i => i.id === physicalWorkId);
      const isDiscussionResult = event.type === 'DISCUSSION_PLAN' || event.type === 'DISCUSSION_RESULT';
      const belongsToDiscussion = isDiscussionResult && !!work?.discussionId && event.discussionId === work.discussionId;
      const mayRetire = isDiscussionResult ? belongsToDiscussion && !!event.fence : !work?.discussionId || event.type === 'WORK_FAILED';
      const retiredCheck = event.type !== 'CHECK_RESULT' || context.stopped || work && (work.epoch !== context.epoch || work.goalVersion !== context.goalVersion);
      if (work && retiredCheck && c.reply.code !== 'DUPLICATE_RESULT'
        && (event.attempt === undefined || event.attempt === work.attempt) && mayRetire && (!event.fence || (event.fence.epoch === work.epoch && event.fence.goalVersion === work.goalVersion))) {
        if (work.discussionId && work.status === 'inflight' && fresh(context, event) && !context.stopped && discussionActive(c)
          && ['INVALID_DISCUSSION_PLAN', 'INVALID_DISCUSSION_RESULT', 'WORK_EXPIRED'].includes(c.reply.code)) discussionFailed(c, event, c.intents.find(item => item.id === work.id)!, c.reply.code);
        else release(c, work.id);
      }
      if (['DISCUSSION_PLAN', 'DISCUSSION_RESULT', 'INTERPRETATION_RESULT', 'HELP_RESULT', 'RECORD_RESULT', 'DELIVER', 'CHECK_RESULT', 'COORDINATE', 'WORK_FAILED', 'BLOCKED'].includes(event.type)) c.lateResults.push(event);
      if (event.type === 'INTERPRETATION_RESULT' && fresh(context, event) && !context.stopped
        && work?.kind === 'interpretation' && work.status === 'inflight' && (event.attempt === undefined || event.attempt === work.attempt)) {
        const input = c.inputAnalyses?.find(input => input.workId === work.id);
        if (input) { input.status = 'failed'; input.error = c.reply.code; }
        c.reason = `输入意图解析校验失败：${c.reply.code}`;
        message(c, event, 'facilitator', c.reason, 'notice');
      }
      if (event.type === 'HELP_RESULT' && (context.stopped || context.outcome !== null
        || ['STALE_FENCE', 'STALE_HELP', 'DUPLICATE_RESULT', 'UNKNOWN_OR_SETTLED_HELP'].includes(c.reply.code))) {
        const r = c.results.find(r => r.resultId === event.resultId); if (r) r.consumed = true;
      }
      c.trace.push({ event: 'REJECTED', detail: `${event.id}:${c.reply.code}`, at: event.at });
      return c;
    }),
    // Only the current coordinating fallback owns this durable human-wait explanation.
    // Generic rejection in another phase or from an old fence must preserve its question.
    explainCoordinationRejection: taskAssign(({ context, event }) => {
      if (event.type !== 'COORDINATE' || context.reply.ok) return {};
      const c = structuredClone(context), code = c.reply.code;
      if (['INVALID_DECISION', 'REVIEW_PLAN_REQUIRED', 'REVIEW_NOT_REQUESTED'].includes(code)) cancelWork(c, event);
      c.reason = `协调决策未被接受：${coordinationProblems[code] ?? '决策未通过当前任务规则校验'}（${code}）。请补充处理方式或重试当前任务。`;
      message(c, event, 'facilitator', c.reason, 'notice');
      return c;
    }),
    boundary: taskAssign(({ context, event }) => {
      const next = reduce(context, { id: `${event.id}:boundary`, at: event.at, type: 'BOUNDARY' });
      next.reply = context.reply; // An internal transition must not overwrite the initiating command's rejection.
      return next;
    }),
    stopped: taskAssign(({ context }) => ({ outcome: 'stopped' as const, reason: context.reason || 'Stopped' })),
    deferred: taskAssign(({ context, event }) => {
      const c = structuredClone(context); coordinate(c, event, c.reason); return c;
    }),
    beginReview: taskAssign(({ context, event }) => {
      const c = structuredClone(context);
      // The initial XState transition has no event timestamp; retain the persisted input clock.
      coordinate(c, { type: 'BOUNDARY', id: event.id ?? 'initial-review', at: event.at ?? c.lastActivityAt }, `用户请求成员评审：${c.review!.request}`);
      return c;
    }),
    beginInterpretation: taskAssign(({ context, event }) => {
      const c = structuredClone(context);
      prepareInterpretation(c, { type: 'BOUNDARY', id: event.id ?? 'initial-interpretation', at: event.at ?? c.lastActivityAt });
      return c;
    }),
    handoffDiscussion: taskAssign(({ context, event }) => reduce(context, { type: 'DISCUSSION_HANDOFF', id: `${event.id}:discussion-handoff`, at: event.at })),
  };
