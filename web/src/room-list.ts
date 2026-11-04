import type { WebRoom } from '../../src/web/contracts.js';

/** No room deletion exists; retain rooms added after an older list request began. */
export function mergeRooms(previous: WebRoom[], incoming: WebRoom[]): WebRoom[] {
  const rooms = new Map(previous.map(room => [room.id, room]));
  for (const room of incoming) {
    const known = rooms.get(room.id);
    if (!known || (room.archiveVersion ?? 0) >= (known.archiveVersion ?? 0)) rooms.set(room.id, room);
  }
  return [...rooms.values()];
}
export const roomList = (rooms: WebRoom[], archived: boolean) => rooms.filter(room => !!room.archived === archived);
