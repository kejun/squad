import type { DeletedRoom, WebRoom } from '../../src/web/contracts.js';

/** A committed deletion is monotonic. Missing list entries alone are not proof
 * of deletion: an older request can predate a concurrent room creation. */
export function mergeRooms(previous: WebRoom[], incoming: WebRoom[], deleted: DeletedRoom[] = []): WebRoom[] {
  const removed = new Set(deleted.map(room => room.roomId));
  const rooms = new Map(previous.filter(room => !removed.has(room.id)).map(room => [room.id, room]));
  for (const room of incoming) {
    if (removed.has(room.id)) continue;
    const known = rooms.get(room.id);
    if (!known || (room.deletion?.version ?? 0) > (known.deletion?.version ?? 0)
      || (room.deletion?.version ?? 0) === (known.deletion?.version ?? 0)
        && (room.archiveVersion ?? 0) >= (known.archiveVersion ?? 0)) rooms.set(room.id, room);
  }
  return [...rooms.values()];
}
export const roomList = (rooms: WebRoom[], archived: boolean) => rooms.filter(room => !!room.archived === archived);
