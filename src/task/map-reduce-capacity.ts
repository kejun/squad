import type { TaskContext } from '../types.js';
import { workInCleanup } from './resilience.js';

/** Only the host selects members; this is the shared planning and dispatch resource view. */
export function availableMapReduceMembers(c: TaskContext) {
  const busy = new Set(c.intents.filter(work => work.kind !== 'cancel'
    && !workInCleanup(c, work) && ['pending', 'inflight', 'uncertain'].includes(work.status)).map(work => work.target));
  return c.config.bots.filter(bot => bot.id !== c.owner && !busy.has(bot.id));
}

/** Reserve synthesis and owner continuation, plus any not-yet-charged interpretation request. */
export function mapReduceCapacity(c: TaskContext, reservedOrdinary = 0): number {
  return Math.max(0, Math.min(availableMapReduceMembers(c).length ? 8 : 0,
    c.config.limits.assists - c.usage.assists,
    c.config.limits.ordinary - c.usage.ordinary - reservedOrdinary - 2));
}

export const mapReduceConcurrency = (c: TaskContext, reservedOrdinary = 0) =>
  Math.min(availableMapReduceMembers(c).length, mapReduceCapacity(c, reservedOrdinary));
