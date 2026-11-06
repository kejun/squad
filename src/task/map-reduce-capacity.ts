import type { TaskContext } from '../types.js';

/** Only the host selects members; this is the shared planning and dispatch resource view. */
export function availableMapReduceMembers(c: TaskContext) {
  const busy = new Set(c.intents.filter(work => work.kind !== 'cancel'
    && ['pending', 'inflight', 'uncertain'].includes(work.status)).map(work => work.target));
  return c.config.bots.filter(bot => bot.id !== c.owner && !busy.has(bot.id));
}

/** Reserve synthesis and owner continuation, plus any not-yet-charged interpretation request. */
export function mapReduceCapacity(c: TaskContext, reservedOrdinary = 0): number {
  return Math.max(0, Math.min(8, availableMapReduceMembers(c).length,
    c.config.limits.assists - c.usage.assists,
    c.config.limits.ordinary - c.usage.ordinary - reservedOrdinary - 2));
}
