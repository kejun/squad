import { createMachine, types } from 'xstate';

/** Process-local resource ownership, independent of durable task execution. */
export const serviceLifecycleMachine = createMachine({
  schemas: {
    events: { RECOVERED: types<{}>(), RECOVERY_FAILED: types<{}>(), CLOSE: types<{}>(), CLOSED: types<{}>() },
  },
  id: 'serviceLifecycle', initial: 'recovering',
  states: {
    recovering: { on: { RECOVERED: { target: 'ready' }, RECOVERY_FAILED: { target: 'startupFailed' }, CLOSE: { target: 'closing' } } },
    ready: { on: { CLOSE: { target: 'closing' } } },
    startupFailed: { on: { CLOSE: { target: 'closing' } } },
    closing: { on: { CLOSED: { target: 'closed' } } },
    closed: { type: 'final' },
  },
});
