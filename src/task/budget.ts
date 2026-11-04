import { type Intent, type TaskContext, type TaskEvent } from '../types.js';
import { discussionActive, hasOrdinary } from './facts.js';

export function requestBudgetProblem(c: TaskContext, work: Intent): string | null {
  if (work.bucket === 'none') return null;
  if (c.usage[work.bucket] >= c.config.limits[work.bucket]) return 'BUDGET_EXHAUSTED';
  if (work.bucket === 'ordinary' && discussionActive(c)) {
    const round = c.discussion!;
    const pending = c.intents.filter(i => i.discussionId === round.id && i.status === 'pending' && i.id !== work.id).length;
    // Reserve every already-promised participant, coordinator synthesis and one owner continuation.
    const reserve = 1 + pending + (round.status === 'planning' ? 2
      : round.status === 'collecting' ? 1 : 0);
    if (c.usage.ordinary + 1 + reserve > c.config.limits.ordinary) return 'DISCUSSION_BUDGET_RESERVED';
  }
  if (work.kind === 'assistance' && c.assists.some(h => h.id === work.payload.requestId && h.retryOf)
    && c.usage.ordinary + 1 >= c.config.limits.ordinary) return 'ASSISTANCE_SYNTHESIS_RESERVED';
  if (work.bucket === 'ordinary' && c.review && ['pending', 'reviewing'].includes(c.review.status)
    && c.usage.ordinary + 1 >= c.config.limits.ordinary) return 'REVIEW_SYNTHESIS_RESERVED';
  return null;
}

export function canRetryWork(c: TaskContext, e: TaskEvent): boolean {
  if (e.type !== 'WORK_FAILED') return false;
  const work = c.intents.find(i => i.id === e.intentId);
  return !!work && e.transient && !e.resultUncertain && work.replay !== 'unsafe' && !c.stopped
    && c.usage.retries < c.config.limits.retries && hasOrdinary(c) && !requestBudgetProblem(c, work);
}
