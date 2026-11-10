import { setup } from 'xstate';

/** Process-local resource ownership, independent of durable task execution. */
export const serviceLifecycleMachine = setup({
  types: { events: {} as { type: 'RECOVERED' | 'RECOVERY_FAILED' | 'CLOSE' | 'CLOSED' } },
}).createMachine({
  id: 'serviceLifecycle', initial: 'recovering',
  states: {
    recovering: { on: { RECOVERED: 'ready', RECOVERY_FAILED: 'startupFailed', CLOSE: 'closing' } },
    ready: { on: { CLOSE: 'closing' } },
    startupFailed: { on: { CLOSE: 'closing' } },
    closing: { on: { CLOSED: 'closed' } },
    closed: { type: 'final' },
  },
});
