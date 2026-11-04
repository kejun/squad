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

export const taskActions = {
    apply: taskAssign(({ context, event }) => reduce(context, event)),
    reject: taskAssign(({ context, event }) => {
      const c = structuredClone(context); reject(c, permissionProblem(c, event) ?? 'INVALID_STATE');
      // A stale completion may retire its own physical work, never advance the new round.
      const physicalWorkId = event.type.startsWith('LOCAL_') ? undefined : event.workId ?? (event.type === 'WORK_FAILED' ? event.intentId : undefined);
      const work = context.intents.find(i => i.id === physicalWorkId);
      const isDiscussionResult = event.type === 'DISCUSSION_PLAN' || event.type === 'DISCUSSION_RESULT';
      const belongsToDiscussion = isDiscussionResult && !!work?.discussionId && event.discussionId === work.discussionId;
      const mayRetire = isDiscussionResult ? belongsToDiscussion && !!event.fence : !work?.discussionId || event.type === 'WORK_FAILED';
      if (work && (event.attempt === undefined || event.attempt === work.attempt) && mayRetire && (!event.fence || (event.fence.epoch === work.epoch && event.fence.goalVersion === work.goalVersion))) {
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
      if (event.type === 'COORDINATE' && fresh(context, event) && !context.stopped && ['INVALID_DECISION', 'REVIEW_PLAN_REQUIRED', 'REVIEW_NOT_REQUESTED'].includes(c.reply.code)) {
        cancelWork(c, event); c.reason = 'Facilitator judgment invalid; human input required';
        message(c, event, 'facilitator', c.reason, 'notice');
      }
      c.trace.push({ event: 'REJECTED', detail: `${event.id}:${c.reply.code}`, at: event.at });
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
