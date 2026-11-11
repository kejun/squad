import { assign, initialTransition, setup, transition, type SnapshotFrom } from 'xstate';

export interface SupervisorPolicy { startupMs: number; graceMs: number; retryMs: number; maxRetryMs: number; failureLimit: number }
export const supervisorDefaults: SupervisorPolicy = { startupMs: 60_000, graceMs: 5_000, retryMs: 1000, maxRetryMs: 30_000, failureLimit: 3 };
export interface SupervisorContext {
  policy: SupervisorPolicy; generation: number; failures: number; restarts: number; deadline: number;
  intent: 'spawn' | 'none' | 'terminate' | 'kill'; stopping: boolean;
}
type SupervisorEvent = { type: 'TICK' | 'STOP'; at: number }
  | { type: 'HEALTH_OK' | 'HEALTH_FAILED' | 'EXIT'; at: number; generation: number };
export const processSupervisorMachine = setup({
  types: { context: {} as SupervisorContext, input: {} as { at: number; policy?: Partial<SupervisorPolicy> }, events: {} as SupervisorEvent },
  guards: {
    current: ({ context, event }) => 'generation' in event && context.generation === event.generation,
    expired: ({ context, event }) => event.at >= context.deadline,
    failed: ({ context, event }) => 'generation' in event && context.generation === event.generation && context.failures + 1 >= context.policy.failureLimit,
  },
  actions: {
    healthy: assign({ failures: 0, intent: 'none' as const }),
    failure: assign(({ context }) => ({ failures: context.failures + 1 })),
    terminate: assign(({ context, event }) => ({ intent: 'terminate' as const, deadline: event.at + context.policy.graceMs })),
    retry: assign(({ context, event }) => ({ intent: 'none' as const, restarts: context.restarts + 1,
      deadline: event.at + Math.min(context.policy.maxRetryMs, context.policy.retryMs * 2 ** Math.min(context.restarts, 10)) })),
    killRetry: assign(({ context, event }) => ({ intent: 'kill' as const, restarts: context.restarts + 1,
      deadline: event.at + Math.min(context.policy.maxRetryMs, context.policy.retryMs * 2 ** Math.min(context.restarts, 10)) })),
    spawn: assign(({ context, event }) => ({ generation: context.generation + 1, failures: 0, intent: 'spawn' as const, deadline: event.at + context.policy.startupMs })),
    stop: assign(({ context, event }) => ({ stopping: true, intent: 'terminate' as const, deadline: event.at + context.policy.graceMs })),
    kill: assign({ intent: 'kill' as const }),
  },
}).createMachine({
  id: 'processSupervisor', initial: 'starting',
  context: ({ input }) => ({ policy: { ...supervisorDefaults, ...input.policy }, generation: 1, failures: 0, restarts: 0,
    deadline: input.at + (input.policy?.startupMs ?? supervisorDefaults.startupMs), intent: 'spawn', stopping: false }),
  states: {
    starting: { on: {
      HEALTH_OK: { guard: 'current', target: 'healthy', actions: 'healthy' },
      EXIT: { guard: 'current', target: 'restarting', actions: 'retry' },
      TICK: { guard: 'expired', target: 'terminating', actions: 'terminate' },
      STOP: { target: 'stopping', actions: 'stop' },
    } },
    healthy: { on: {
      HEALTH_OK: { guard: 'current', actions: 'healthy' },
      HEALTH_FAILED: [{ guard: 'failed', target: 'terminating', actions: 'terminate' }, { guard: 'current', actions: 'failure' }],
      EXIT: { guard: 'current', target: 'restarting', actions: 'retry' },
      STOP: { target: 'stopping', actions: 'stop' },
    } },
    terminating: { on: { EXIT: { guard: 'current', target: 'restarting', actions: 'retry' }, TICK: { guard: 'expired', target: 'restarting', actions: 'killRetry' }, STOP: { target: 'stopping', actions: 'stop' } } },
    restarting: { on: { TICK: { guard: 'expired', target: 'starting', actions: 'spawn' }, STOP: 'stopped' } },
    stopping: { on: { EXIT: { guard: 'current', target: 'stopped' }, TICK: { guard: 'expired', target: 'stopped', actions: 'kill' } } },
    stopped: { type: 'final' },
  },
});
export type SupervisorSnapshot = SnapshotFrom<typeof processSupervisorMachine>;
export const initialSupervisor = (at: number, policy?: Partial<SupervisorPolicy>) => initialTransition(processSupervisorMachine, { at, ...(policy ? { policy } : {}) })[0];
export const stepSupervisor = (snapshot: SupervisorSnapshot, event: SupervisorEvent) => transition(processSupervisorMachine, snapshot, event)[0];
