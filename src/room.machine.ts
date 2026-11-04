import { assign, initialTransition, setup, transition } from 'xstate';

export interface RoomArchive {
  version: 1;
  value: 'active' | 'archived';
  revision: number;
  changedAt: number | null;
}
type RoomEvent = { type: 'ARCHIVE' | 'RESTORE'; at: number };
interface RoomContext { revision: number; changedAt: number | null }

// Room organization is independent of all task states, intent eligibility and budgets.
export const roomMachine = setup({
  types: { context: {} as RoomContext, events: {} as RoomEvent },
  guards: { valid: ({ context, event }) => Number.isSafeInteger(event.at) && event.at >= 0 && context.revision < Number.MAX_SAFE_INTEGER },
  actions: { changed: assign(({ context, event }) => ({ revision: context.revision + 1, changedAt: event.at })) },
}).createMachine({
  id: 'room-organization', initial: 'active', context: { revision: 0, changedAt: null },
  states: {
    active: { on: { ARCHIVE: { guard: 'valid', target: 'archived', actions: 'changed' } } },
    archived: { on: { RESTORE: { guard: 'valid', target: 'active', actions: 'changed' } } },
  },
});

export function restoreRoomArchive(saved?: RoomArchive) {
  if (!saved) return initialTransition(roomMachine)[0];
  if (saved.version !== 1 || !['active', 'archived'].includes(saved.value) || !Number.isSafeInteger(saved.revision) || saved.revision < 0
    || !(saved.changedAt === null || Number.isSafeInteger(saved.changedAt) && saved.changedAt >= 0)) throw new Error('Incompatible room archive state');
  return roomMachine.resolveState({ value: saved.value, context: { revision: saved.revision, changedAt: saved.changedAt } });
}
export function stepRoomArchive(saved: RoomArchive | undefined, event: RoomEvent): RoomArchive {
  const [next] = transition(roomMachine, restoreRoomArchive(saved), event);
  return { version: 1, value: next.value as RoomArchive['value'], ...next.context };
}
