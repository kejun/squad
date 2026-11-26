import { createMachine, initialTransition, transition, types, type EventFrom, type SnapshotFrom } from 'xstate';

export interface SupervisorPolicy { startupMs: number; graceMs: number; retryMs: number; maxRetryMs: number; failureLimit: number }
export const supervisorDefaults: SupervisorPolicy = { startupMs: 60_000, graceMs: 5_000, retryMs: 1000, maxRetryMs: 30_000, failureLimit: 3 };
export interface SupervisorContext {
  policy: SupervisorPolicy; generation: number; failures: number; restarts: number; deadline: number;
  intent: 'spawn' | 'none' | 'terminate' | 'kill'; stopping: boolean;
}
type TimedEvent = { at: number };
type ProcessEvent = TimedEvent & { generation: number };

const current = (context: SupervisorContext, event: ProcessEvent) => context.generation === event.generation;
const healthy = { failures: 0, intent: 'none' } as const;
const terminate = (context: SupervisorContext, at: number) => ({ intent: 'terminate' as const, deadline: at + context.policy.graceMs });
const retry = (context: SupervisorContext, at: number, intent: 'none' | 'kill' = 'none') => ({
  intent, restarts: context.restarts + 1,
  deadline: at + Math.min(context.policy.maxRetryMs, context.policy.retryMs * 2 ** Math.min(context.restarts, 10)),
});

export const processSupervisorMachine = createMachine({
  schemas: {
    context: types<SupervisorContext>(),
    input: types<{ at: number; policy?: Partial<SupervisorPolicy> }>(),
    events: {
      TICK: types<TimedEvent>(), STOP: types<TimedEvent>(),
      HEALTH_OK: types<ProcessEvent>(), HEALTH_FAILED: types<ProcessEvent>(), EXIT: types<ProcessEvent>(),
    },
  },
  id: 'processSupervisor', initial: 'starting',
  context: ({ input }) => ({ policy: { ...supervisorDefaults, ...input.policy }, generation: 1, failures: 0, restarts: 0,
    deadline: input.at + (input.policy?.startupMs ?? supervisorDefaults.startupMs), intent: 'spawn', stopping: false }),
  states: {
    starting: { on: {
      HEALTH_OK: ({ context, event }) => current(context, event) ? { target: 'healthy', context: healthy } : undefined,
      EXIT: ({ context, event }) => current(context, event) ? { target: 'restarting', context: retry(context, event.at) } : undefined,
      TICK: ({ context, event }) => event.at >= context.deadline ? { target: 'terminating', context: terminate(context, event.at) } : undefined,
      STOP: ({ context, event }) => ({ target: 'stopping', context: { ...terminate(context, event.at), stopping: true } }),
    } },
    healthy: { on: {
      HEALTH_OK: ({ context, event }) => current(context, event) ? { context: healthy } : undefined,
      HEALTH_FAILED: ({ context, event }) => {
        if (!current(context, event)) return;
        const failures = context.failures + 1;
        return failures >= context.policy.failureLimit
          ? { target: 'terminating', context: terminate(context, event.at) }
          : { context: { failures } };
      },
      EXIT: ({ context, event }) => current(context, event) ? { target: 'restarting', context: retry(context, event.at) } : undefined,
      STOP: ({ context, event }) => ({ target: 'stopping', context: { ...terminate(context, event.at), stopping: true } }),
    } },
    terminating: { on: {
      EXIT: ({ context, event }) => current(context, event) ? { target: 'restarting', context: retry(context, event.at) } : undefined,
      TICK: ({ context, event }) => event.at >= context.deadline ? { target: 'restarting', context: retry(context, event.at, 'kill') } : undefined,
      STOP: ({ context, event }) => ({ target: 'stopping', context: { ...terminate(context, event.at), stopping: true } }),
    } },
    restarting: { on: {
      TICK: ({ context, event }) => event.at >= context.deadline ? { target: 'starting', context: {
        generation: context.generation + 1, failures: 0, intent: 'spawn' as const, deadline: event.at + context.policy.startupMs,
      } } : undefined,
      STOP: { target: 'stopped' },
    } },
    stopping: { on: {
      EXIT: ({ context, event }) => current(context, event) ? { target: 'stopped' } : undefined,
      TICK: ({ context, event }) => event.at >= context.deadline ? { target: 'stopped', context: { intent: 'kill' as const } } : undefined,
    } },
    stopped: { type: 'final' },
  },
});
export type SupervisorSnapshot = SnapshotFrom<typeof processSupervisorMachine>;
type SupervisorEvent = EventFrom<typeof processSupervisorMachine>;
export const initialSupervisor = (at: number, policy?: Partial<SupervisorPolicy>) => initialTransition(processSupervisorMachine, { at, ...(policy ? { policy } : {}) })[0];
export const stepSupervisor = (snapshot: SupervisorSnapshot, event: SupervisorEvent) => transition(processSupervisorMachine, snapshot, event)[0];
