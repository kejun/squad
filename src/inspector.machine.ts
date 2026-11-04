import { assign, setup } from 'xstate';
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
type InspectorEvent =
  | { type: 'UPDATE'; frame: InspectorFrame }
  | { type: 'SELECT'; frame: InspectorFrame }
  | { type: 'CONNECT'; origin: string; fromTarget: boolean }
  | { type: 'CLOSE' };

// Ephemeral observation only. No task events, work claims or external actions run here.
export const inspectorMachine = setup({
  types: {
    context: {} as InspectorContext,
    events: {} as InspectorEvent,
    input: {} as InspectorFrame,
  },
  guards: {
    trusted: ({ event }) => event.type === 'CONNECT' && event.fromTarget && event.origin === inspectorOrigin,
  },
  actions: {
    remember: assign(({ event }) => event.type === 'UPDATE' || event.type === 'SELECT' ? { latest: structuredClone(event.frame) } : {}),
    register: assign(({ context }) => ({ delivery: {
      sequence: (context.delivery?.sequence ?? 0) + 1, kind: 'register' as const, frame: context.latest,
    } })),
    update: assign(({ context, event }) => {
      if (event.type !== 'UPDATE') return {};
      const frame = structuredClone(event.frame);
      return { latest: frame, delivery: {
        sequence: (context.delivery?.sequence ?? 0) + 1, kind: 'update' as const, frame,
      } };
    }),
    disconnect: assign(({ context }) => ({ delivery: {
      sequence: (context.delivery?.sequence ?? 0) + 1, kind: 'disconnect' as const, frame: context.latest,
    } })),
  },
}).createMachine({
  id: 'inspector-observer',
  context: ({ input }) => ({ latest: structuredClone(input), delivery: null }),
  initial: 'waiting',
  states: {
    waiting: { on: {
      UPDATE: { actions: 'remember' },
      SELECT: { actions: 'remember' },
      CONNECT: { guard: 'trusted', target: 'connected', actions: 'register' },
      CLOSE: 'closed',
    } },
    connected: { on: {
      UPDATE: { actions: 'update' },
      SELECT: { actions: ['remember', 'register'] },
      CONNECT: { guard: 'trusted', actions: 'register' },
      CLOSE: { target: 'closed', actions: 'disconnect' },
    } },
    closed: { type: 'final' },
  },
});

type WindowEvent = { type: 'OPEN' | 'OPENED' | 'BLOCKED' | 'WINDOW_CLOSED' | 'DISPOSE' };
interface WindowContext { effect: { sequence: number; kind: 'open' | 'focus' | 'disconnect' } | null }
// Browser effects are consumed synchronously by the click controller, not by a React effect.
export const inspectorWindowMachine = setup({
  types: { context: {} as WindowContext, events: {} as WindowEvent },
  actions: {
    open: assign(({ context }) => ({ effect: { sequence: (context.effect?.sequence ?? 0) + 1, kind: 'open' as const } })),
    focus: assign(({ context }) => ({ effect: { sequence: (context.effect?.sequence ?? 0) + 1, kind: 'focus' as const } })),
    disconnect: assign(({ context }) => ({ effect: { sequence: (context.effect?.sequence ?? 0) + 1, kind: 'disconnect' as const } })),
  },
}).createMachine({
  id: 'inspector-window', context: { effect: null }, initial: 'closed',
  on: { DISPOSE: { target: '.disposed', actions: 'disconnect' } },
  states: {
    closed: { on: { OPEN: { target: 'opening', actions: 'open' } } },
    opening: { on: { OPENED: 'open', BLOCKED: 'blocked' } },
    blocked: { on: { OPEN: { target: 'opening', actions: 'open' } } },
    open: { on: {
      OPEN: { actions: 'focus' },
      WINDOW_CLOSED: { target: 'closed', actions: 'disconnect' },
    } },
    disposed: { type: 'final' },
  },
});
