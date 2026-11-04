import { describe, expect, it } from 'vitest';
import { initialTransition, transition } from 'xstate';
import { roomMachine, restoreRoomArchive, stepRoomArchive } from '../src/room.machine.js';
import { mergeRooms, roomList } from '../web/src/room-list.js';

describe('room archive pure model', () => {
  it('[BT_G15] restores an archived room and advances its archive revision', () => {
    let [room] = initialTransition(roomMachine);
    [room] = transition(roomMachine, room, { type: 'ARCHIVE', at: 10 });
    expect(room.value).toBe('archived'); expect(room.context).toEqual({ revision: 1, changedAt: 10 });
    [room] = transition(roomMachine, room, { type: 'RESTORE', at: 20 });
    expect(room.value).toBe('active'); expect(room.context.revision).toBe(2);
  });
  it('[BT_G17] defaults old rooms to active and restores a persisted empty-room archive', () => {
    expect(restoreRoomArchive().value).toBe('active');
    const saved = stepRoomArchive(undefined, { type: 'ARCHIVE', at: 12 });
    expect(restoreRoomArchive(JSON.parse(JSON.stringify(saved))).value).toBe('archived');
    expect(restoreRoomArchive(saved).context).toEqual({ revision: 1, changedAt: 12 });
  });
  it('[BT_G18] repeated desired states do not increment revisions or touch another room', () => {
    const archived = stepRoomArchive(undefined, { type: 'ARCHIVE', at: 1 });
    expect(stepRoomArchive(archived, { type: 'ARCHIVE', at: 2 })).toEqual(archived);
    const restored = stepRoomArchive(archived, { type: 'RESTORE', at: 3 });
    expect(stepRoomArchive(restored, { type: 'RESTORE', at: 4 })).toEqual(restored);
    expect(restoreRoomArchive().context.revision).toBe(0);
  });
  it('[BT_G19] refuses an archive event with an invalid timestamp', () => {
    expect(stepRoomArchive(undefined, { type: 'ARCHIVE', at: -1 }).value).toBe('active');
  });
  it('[BT_G19] refuses a persisted archive with a corrupt revision', () => {
    expect(() => restoreRoomArchive({ version: 1, value: 'archived', revision: -1, changedAt: null })).toThrow();
  });
  it('[BT_G22] rejects stale list/snapshot archive versions and keeps lists disjoint', () => {
    const old = { id: 'one', title: '同一群', createdAt: 1, archived: false, archiveVersion: 0 };
    const archived = { ...old, archived: true, archiveVersion: 1 };
    const restored = { ...old, archiveVersion: 2 };
    expect(mergeRooms([archived], [old])).toEqual([archived]);
    const merged = mergeRooms([restored], [archived, old]);
    expect(merged).toEqual([restored]);
    expect(roomList(merged, true)).toHaveLength(0); expect(roomList(merged, false)).toEqual([restored]);
    expect(mergeRooms([old, { ...old, id: 'new' }], [old])).toHaveLength(2);
  });
});
