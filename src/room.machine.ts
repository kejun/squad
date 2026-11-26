import { createMachine, initialTransition, transition, types } from 'xstate';

export interface RoomArchive {
  version: 1;
  value: 'active' | 'archived';
  revision: number;
  changedAt: number | null;
}
type RoomEvent = { type: 'ARCHIVE' | 'RESTORE'; at: number };
interface RoomContext { revision: number; changedAt: number | null }
function archiveChange(context: RoomContext, at: number): RoomContext | undefined {
  if (Number.isSafeInteger(at) && at >= 0 && context.revision < Number.MAX_SAFE_INTEGER) {
    return { revision: context.revision + 1, changedAt: at };
  }
}

// Room organization is independent of all task states, intent eligibility and budgets.
export const roomMachine = createMachine({
  schemas: {
    context: types<RoomContext>(),
    events: { ARCHIVE: types<{ at: number }>(), RESTORE: types<{ at: number }>() },
  },
  id: 'room-organization', initial: 'active', context: { revision: 0, changedAt: null },
  states: {
    active: { on: { ARCHIVE: ({ context, event }) => {
      const change = archiveChange(context, event.at);
      if (change) return { target: 'archived', context: change };
    } } },
    archived: { on: { RESTORE: ({ context, event }) => {
      const change = archiveChange(context, event.at);
      if (change) return { target: 'active', context: change };
    } } },
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
