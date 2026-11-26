import { setup, types } from 'xstate';
import type { DebugEvent } from './task-debug.js';

export const inspectorOrigin = 'https://stately.ai';
export const inspectorUrl = inspectorOrigin + '/inspect';
export interface InspectorFrame { snapshot: unknown; event: DebugEvent | undefined }
export interface InspectorDelivery {
  sequence: number;
  kind: 'register' | 'update' | 'disconnect';
  frame: InspectorFrame;
}
interface InspectorContext { latest: InspectorFrame; delivery: InspectorDelivery | null }
interface InspectorHandshake { origin: string; fromTarget: boolean }
const trusted = ({ origin, fromTarget }: InspectorHandshake) => fromTarget && origin === inspectorOrigin;
const delivery = (context: InspectorContext, kind: InspectorDelivery['kind'], frame = context.latest) => ({
  sequence: (context.delivery?.sequence ?? 0) + 1, kind, frame,
});

// Ephemeral observation only. No task events, work claims or external actions run here.
export const inspectorMachine = setup({
  schemas: {
    context: types<InspectorContext>(),
    events: {
      UPDATE: types<{ frame: InspectorFrame }>(),
      SELECT: types<{ frame: InspectorFrame }>(),
      CONNECT: types<InspectorHandshake>(),
      CLOSE: types<{}>(),
    },
    input: types<InspectorFrame>(),
  },
}).createMachine({
  id: 'inspector-observer',
  context: ({ input }) => ({ latest: structuredClone(input), delivery: null }),
  initial: 'waiting',
  states: {
    waiting: { on: {
      UPDATE: ({ event }) => ({ context: { latest: structuredClone(event.frame) } }),
      SELECT: ({ event }) => ({ context: { latest: structuredClone(event.frame) } }),
      CONNECT: ({ context, event }) => trusted(event)
        ? { target: 'connected', context: { delivery: delivery(context, 'register') } }
        : undefined,
      CLOSE: { target: 'closed' },
    } },
    connected: { on: {
      UPDATE: ({ context, event }) => {
        const frame = structuredClone(event.frame);
        return { context: { latest: frame, delivery: delivery(context, 'update', frame) } };
      },
      SELECT: ({ context, event }) => {
        const frame = structuredClone(event.frame);
        return { context: { latest: frame, delivery: delivery(context, 'register', frame) } };
      },
      CONNECT: ({ context, event }) => trusted(event) ? { context: { delivery: delivery(context, 'register') } } : undefined,
      CLOSE: ({ context }) => ({ target: 'closed', context: { delivery: delivery(context, 'disconnect') } }),
    } },
    closed: { type: 'final' },
  },
});

interface WindowEffect { sequence: number; kind: 'open' | 'focus' | 'disconnect' }
interface WindowContext { effect: WindowEffect | null }
const windowEffect = (context: WindowContext, kind: WindowEffect['kind']): WindowEffect => ({
  sequence: (context.effect?.sequence ?? 0) + 1, kind,
});
// Browser effects are consumed synchronously by the click controller, not by a React effect.
export const inspectorWindowMachine = setup({
  schemas: {
    context: types<WindowContext>(),
    events: { OPEN: types<{}>(), OPENED: types<{}>(), BLOCKED: types<{}>(), WINDOW_CLOSED: types<{}>(), DISPOSE: types<{}>() },
  },
}).createMachine({
  id: 'inspector-window', context: { effect: null }, initial: 'closed',
  on: { DISPOSE: ({ context }) => ({ target: '.disposed', context: { effect: windowEffect(context, 'disconnect') } }) },
  states: {
    closed: { on: { OPEN: ({ context }) => ({ target: 'opening', context: { effect: windowEffect(context, 'open') } }) } },
    opening: { on: { OPENED: { target: 'open' }, BLOCKED: { target: 'blocked' } } },
    blocked: { on: { OPEN: ({ context }) => ({ target: 'opening', context: { effect: windowEffect(context, 'open') } }) } },
    open: { on: {
      OPEN: ({ context }) => ({ context: { effect: windowEffect(context, 'focus') } }),
      WINDOW_CLOSED: ({ context }) => ({ target: 'closed', context: { effect: windowEffect(context, 'disconnect') } }),
    } },
    disposed: { type: 'final' },
  },
});
