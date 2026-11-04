import { setup } from 'xstate';
import type { Fence, Intent } from '../types.js';

/** Immutable authorization identity. Execution state is owned only by this child actor. */
export interface ExecutionTicket extends Fence {
  taskId: string; intentId: string; attempt: number; kind: Intent['kind']; target: string;
}
export type ExecutionEvent =
  | { type: 'START'; ticket: ExecutionTicket }
  | { type: 'PARENT_FACTS'; status: Intent['status']; attempt: number; stopped: boolean; fence: Fence };
export const executionId = (intentId: string, attempt: number) => `execution:${intentId}:${attempt}`;
export const executionTicket = (taskId: string, work: Intent): ExecutionTicket => ({
  taskId, intentId: work.id, attempt: work.attempt, kind: work.kind, target: work.target, epoch: work.epoch, goalVersion: work.goalVersion,
});

export const executionMachine = setup({
  types: { context: {} as ExecutionTicket, input: {} as ExecutionTicket, events: {} as ExecutionEvent },
  guards: {
    sameTicket: ({ context, event }) => event.type === 'START' && Object.keys(context).every(key => context[key as keyof ExecutionTicket] === event.ticket[key as keyof ExecutionTicket]),
    settled: ({ event }) => event.type === 'PARENT_FACTS' && ['done', 'cancelled'].includes(event.status),
    uncertain: ({ event }) => event.type === 'PARENT_FACTS' && event.status === 'uncertain',
    interrupted: ({ context, event }) => event.type === 'PARENT_FACTS' && (event.status === 'pending' || event.attempt !== context.attempt),
    revoked: ({ context, event }) => event.type === 'PARENT_FACTS' && context.kind !== 'cancel'
      && (event.stopped || event.fence.epoch !== context.epoch || event.fence.goalVersion !== context.goalVersion),
  },
}).createMachine({
  id: 'taskExecution', initial: 'authorized', context: ({ input }) => ({ ...input }),
  states: {
    authorized: { on: {
      START: { guard: 'sameTicket', target: 'running' },
      PARENT_FACTS: [{ guard: 'settled', target: 'settled' }, { guard: 'uncertain', target: 'uncertain' }, { guard: 'revoked', target: 'cancelled' }, { guard: 'interrupted', target: 'interrupted' }],
    } },
    running: { on: { PARENT_FACTS: [
      { guard: 'settled', target: 'settled' }, { guard: 'uncertain', target: 'uncertain' },
      { guard: 'interrupted', target: 'interrupted' }, { guard: 'revoked', target: 'cancelling' },
    ] } },
    cancelling: { on: { PARENT_FACTS: [
      { guard: 'settled', target: 'settled' }, { guard: 'uncertain', target: 'uncertain' }, { guard: 'interrupted', target: 'interrupted' },
    ] } },
    uncertain: { on: { PARENT_FACTS: [{ guard: 'settled', target: 'settled' }, { guard: 'interrupted', target: 'interrupted' }] } },
    settled: { type: 'final' }, cancelled: { type: 'final' }, interrupted: { type: 'final' },
  },
});
