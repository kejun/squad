import { maximumCount } from '../budget-defaults.js';
import { hostRetryReservation } from '../host-retry.js';
import { type Intent, type TaskContext, type TaskEvent } from '../types.js';
import { discussionActive, hasOrdinary } from './facts.js';
import { deliveryCheckBudgetProblem, hasDeliveryRetryPermit, isBoundedCheck } from './delivery.js';
import { queuedMapPartitions } from './map-queue.js';

export function requestBudgetProblem(c: TaskContext, work: Intent): string | null {
  if (work.bucket === 'none') return null;
  if (work.bucket === 'checks') return deliveryCheckBudgetProblem(c, hasDeliveryRetryPermit(c, work));
  if (c.usage[work.bucket] >= c.config.limits[work.bucket]) return 'BUDGET_EXHAUSTED';
  const hostReserve = work.id === c.hostRetryBatch?.workId ? 0 : hostRetryReservation(c);
  if (work.bucket === 'ordinary' && c.usage.ordinary + 1 + hostReserve > c.config.limits.ordinary) return 'BUDGET_EXHAUSTED';
  if (work.bucket === 'ordinary' && discussionActive(c)) {
    const round = c.discussion!;
    const pending = c.intents.filter(i => i.discussionId === round.id && i.status === 'pending' && i.id !== work.id).length;
    // Reserve every already-promised participant, coordinator synthesis and one owner continuation.
    const reserve = 1 + pending + queuedMapPartitions(c) + (round.status === 'planning' ? 2
      : round.status === 'collecting' ? 1 : 0);
    if (c.usage.ordinary + 1 + reserve + hostReserve > c.config.limits.ordinary) return 'DISCUSSION_BUDGET_RESERVED';
  }
  if (work.kind === 'assistance' && c.assists.some(h => h.id === work.payload.requestId && h.retryOf)
    && c.usage.ordinary + 1 >= c.config.limits.ordinary) return 'ASSISTANCE_SYNTHESIS_RESERVED';
  if (work.bucket === 'ordinary' && c.review && ['pending', 'reviewing'].includes(c.review.status)
    && c.usage.ordinary + 1 >= c.config.limits.ordinary) return 'REVIEW_SYNTHESIS_RESERVED';
  return null;
}

export function canRetryWork(c: TaskContext, e: TaskEvent): boolean {
  if (e.type !== 'WORK_FAILED' || e.code === 'WINDOW_EXPIRED') return false;
  const work = c.intents.find(i => i.id === e.intentId);
  if (isBoundedCheck(work)) return e.transient && !e.resultUncertain && canRetryDeliveryCheck(c, work, e.at, !!e.checkDiagnostic);
  return !!work && e.transient && !e.resultUncertain && work.replay !== 'unsafe' && !c.stopped
    && c.usage.retries < c.config.limits.retries && hasOrdinary(c) && !requestBudgetProblem(c, work);
}

export function canRetryDeliveryCheck(c: TaskContext, work: Intent, at: number, protocolError = false): boolean {
  return !!c.deliveryCycle && (!c.deliveryCycle.retry || !protocolError && c.config.limits.retries === maximumCount && c.deliveryCycle.retry.status === 'used') && !c.stopped && work.requestCount > 0
    && c.usage.retries < c.config.limits.retries && !deliveryCheckBudgetProblem(c, true)
    && (work.deadline === null || at < work.deadline);
}

export function reserveDeliveryRetry(c: TaskContext, work: Intent): void {
  c.deliveryCycle!.retry = { workId: work.id, status: 'reserved' };
  c.usage.retries++;
}
