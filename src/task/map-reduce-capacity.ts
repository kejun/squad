import type { TaskContext } from '../types.js';
import { processingWindow, workInCleanup } from './resilience.js';

export function mapQueueWindowDeadline(c: TaskContext): number {
  const { hardDeadline, repairDeadline } = processingWindow(c);
  return Math.min(hardDeadline, repairDeadline ?? hardDeadline);
}

/** Only the host selects members; this is the shared planning and dispatch resource view. */
export function availableMapReduceMembers(c: TaskContext) {
  const busy = new Set(c.intents.filter(work => work.kind !== 'cancel'
    && !workInCleanup(c, work) && ['pending', 'inflight', 'uncertain'].includes(work.status)).map(work => work.target));
  return c.config.bots.filter(bot => bot.id !== c.owner && !busy.has(bot.id));
}

/** Reserve downstream requests plus any not-yet-charged interpretation request. */
export function mapReduceCapacity(c: TaskContext, reservedOrdinary = 0, downstreamRequests = 2): number {
  return Math.max(0, Math.min(availableMapReduceMembers(c).length ? 8 : 0,
    c.config.limits.assists - c.usage.assists,
    c.config.limits.ordinary - c.usage.ordinary - reservedOrdinary - downstreamRequests));
}

export const mapReduceConcurrency = (c: TaskContext, reservedOrdinary = 0) =>
  Math.min(availableMapReduceMembers(c).length, mapReduceCapacity(c, reservedOrdinary));
