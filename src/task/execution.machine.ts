import { createMachine, types } from 'xstate';
import type { Fence, Intent } from '../types.js';

/** Immutable authorization identity. Execution state is owned only by this child actor. */
export interface ExecutionTicket extends Fence {
  taskId: string; intentId: string; attempt: number; kind: Intent['kind']; target: string;
}
export type ExecutionEvent =
  | { type: 'START'; ticket: ExecutionTicket }
  | { type: 'PARENT_FACTS'; status: Intent['status']; attempt: number; stopped: boolean; fence: Fence };
export const executionId = (intentId: string, attempt: number): `execution:${string}:${number}` => `execution:${intentId}:${attempt}`;
export const executionTicket = (taskId: string, work: Intent): ExecutionTicket => ({
  taskId, intentId: work.id, attempt: work.attempt, kind: work.kind, target: work.target, epoch: work.epoch, goalVersion: work.goalVersion,
});

export const executionLifecycle = {
  id: 'taskExecution', initial: 'authorized',
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
} as const;

type ParentFacts = Extract<ExecutionEvent, { type: 'PARENT_FACTS' }>;
type Facts = { context: ExecutionTicket; event: ParentFacts };
type ExecutionGuards = (args: Facts) => boolean;
type ExecutionPhase = keyof typeof executionLifecycle.states;
export type TerminalExecutionState = 'settled' | 'cancelled' | 'interrupted';
export function isTerminalExecutionState(value: unknown): value is TerminalExecutionState {
  return value === 'settled' || value === 'cancelled' || value === 'interrupted';
}

const parentGuards = {
  settled: ({ event }) => event.status === 'done' || event.status === 'cancelled',
  uncertain: ({ event }) => event.status === 'uncertain',
  interrupted: ({ context, event }) => event.status === 'pending' || event.attempt !== context.attempt,
  revoked: ({ context, event }) => context.kind !== 'cancel'
    && (event.stopped || event.fence.epoch !== context.epoch || event.fence.goalVersion !== context.goalVersion),
} satisfies Record<string, ExecutionGuards>;

function parentFacts(rules: readonly { guard: keyof typeof parentGuards; target: ExecutionPhase }[]) {
  return (args: Facts) => {
    const selected = rules.find(rule => parentGuards[rule.guard](args));
    if (selected) return { target: selected.target };
  };
}

export const executionMachine = createMachine({
  id: executionLifecycle.id,
  schemas: {
    context: types<ExecutionTicket>(), input: types<ExecutionTicket>(),
    events: { START: types<{ ticket: ExecutionTicket }>(), PARENT_FACTS: types<Omit<ParentFacts, 'type'>>() },
  },
  initial: executionLifecycle.initial,
  context: ({ input }) => ({ ...input }),
  states: {
    authorized: { on: {
      START: ({ context, event: { ticket } }) => {
        if (context.taskId === ticket.taskId && context.intentId === ticket.intentId && context.attempt === ticket.attempt
          && context.kind === ticket.kind && context.target === ticket.target
          && context.epoch === ticket.epoch && context.goalVersion === ticket.goalVersion)
          return { target: executionLifecycle.states.authorized.on.START.target };
      },
      PARENT_FACTS: parentFacts(executionLifecycle.states.authorized.on.PARENT_FACTS),
    } },
    running: { on: { PARENT_FACTS: parentFacts(executionLifecycle.states.running.on.PARENT_FACTS) } },
    cancelling: { on: { PARENT_FACTS: parentFacts(executionLifecycle.states.cancelling.on.PARENT_FACTS) } },
    uncertain: { on: { PARENT_FACTS: parentFacts(executionLifecycle.states.uncertain.on.PARENT_FACTS) } },
    // V6 removes final children. Keep each historical permit as an inert child so
    // its exact attempt remains distinguishable from a claim that never existed.
    settled: {}, cancelled: {}, interrupted: {},
  },
});
