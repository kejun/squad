import { describe, expect, it } from 'vitest';
import { RoomArchiveFixture, archiveUntil } from './room-archive-fixture.js';
import { SqliteStore } from '../src/store.js';
import type { WebRoom } from '../src/web/contracts.js';

describe('durable room archive HTTP boundary', () => {
  it('[BT_G15] moves the same room between lists and preserves messages and task artifacts', async () => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(); await test.seed();
      expect((await test.change(true, 'archive')).data.archived).toBe(true); test.assertHistory();
      const rooms = (await test.request<{ rooms: WebRoom[] }>('/api/rooms')).data.rooms;
      expect(rooms.filter(room => room.archived).map(room => room.id)).toEqual([test.first.id]);
      expect(rooms.filter(room => !room.archived).map(room => room.id)).toEqual([test.second.id]);
      expect((await test.change(false, 'restore')).data.archived).toBe(false); test.assertHistory();
    } finally { await test.close(); }
  });
  it('[BT_G16] finishes inflight work after archive and routes new messages without restoring it', async () => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(); test.first = test.service.createRoom(); test.hold = true;
      await test.request(test.route() + '/messages', { id: 'held', text: '在途工作' });
      await archiveUntil(() => test.release, Boolean);
      const before = test.service.snapshot(test.first.id);
      await test.change(true, 'archive-inflight');
      expect(test.service.snapshot(test.first.id).tasks).toEqual(before.tasks); expect(test.cancelled).toBe(0);
      test.release!();
      const done = await archiveUntil(() => test.service.snapshot(test.first.id), value => value.tasks[0]?.outcome === 'complete');
      expect(done.tasks[0]!.usage).toEqual({ ordinary: 1, checks: 1 }); expect(done.room.archived).toBe(true);
      await test.request(test.route() + '/messages', { id: 'next', text: '新工作' });
      const next = await archiveUntil(() => test.service.snapshot(test.first.id), value => value.tasks.length === 2 && value.tasks.at(-1)?.outcome === 'complete');
      expect(next.room.archived).toBe(true); expect(test.calls).toBe(4); expect(test.cancelled).toBe(0);
    } finally { await test.close(); }
  });
  it('[BT_G17] restores archive metadata for empty rooms and defaults legacy records to active', async () => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(true); test.first = test.service.createRoom('空群'); await test.change(true, 'empty'); await test.restart();
      expect(test.service.rooms().find(room => room.id === 'legacy')?.archived).toBe(false);
      const empty = test.service.snapshot(test.first.id); expect(empty.room.archived).toBe(true); expect(empty.tasks).toHaveLength(0);
    } finally { await test.close(); }
  });
  it('[BT_G18] rejects conflicting ids and prevents an old archive receipt from undoing restore', async () => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(); await test.seed();
      await test.change(true, 'one'); await test.change(true, 'one'); await test.change(true, 'same-target');
      expect(test.service.engine.roomArchive(test.first.id).archiveVersion).toBe(1);
      await test.change(false, 'two'); expect((await test.change(true, 'one')).data.archived).toBe(false);
      expect((await test.change(false, 'one')).status).toBe(409);
      expect(test.service.engine.roomArchive(test.first.id).archiveVersion).toBe(2);
      expect(test.service.engine.roomArchive(test.second.id).archiveVersion).toBe(0); test.assertHistory();
    } finally { await test.close(); }
  });
  it.each(['缺少标识', '空标识', '群聊不存在', '错误方法', '跨来源'])('[BT_G19] rejects %s without mutation', async problem => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(); await test.seed(); const before = test.readStored();
      const route = test.route(problem === '群聊不存在' ? 'missing' : test.first.id) + '/archive';
      const result = await test.request(route, problem === '错误方法' ? undefined : { ...(problem !== '缺少标识' ? { id: problem === '空标识' ? '' : 'bad' } : {}) },
        problem === '错误方法' ? 'GET' : 'POST', problem === '跨来源' ? 'https://example.org' : undefined);
      expect(result.status).toBe(problem === '群聊不存在' ? 404 : problem === '错误方法' ? 405 : problem === '跨来源' ? 403 : 400);
      expect(test.readStored()).toEqual(before); test.assertHistory();
    } finally { await test.close(); }
  });
  it('[BT_G20] rolls back metadata and receipt on failed commit and retries after reopening', async () => {
    const test = new RoomArchiveFixture();
    try {
      await test.start(); await test.seed(); const before = test.readStored();
      (test.service.engine.store as SqliteStore).failNextCommit = true;
      expect((await test.change(true, 'fault')).status).toBe(500); expect(test.readStored()).toEqual(before); test.assertHistory();
      await test.restart(); expect((await test.change(true, 'fault')).status).toBe(200);
      expect(test.service.engine.roomArchive(test.first.id)).toEqual({ archived: true, archiveVersion: 1 }); test.assertHistory();
    } finally { await test.close(); }
  });
});
