import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { deletionStore } from '../src/store.js';
import { DeletionServiceFixture, deletionUntil, directorySnapshot } from './room-deletion-acceptance.js';
import { verifyForceRoomDeletionModel } from './force-room-deletion-model-fixture.js';

/** HTTP + SQLite + actual runtime files; no application response is stubbed. */
export class ForceRoomDeletionCase {
  host!: DeletionServiceFixture;
  result?: Awaited<ReturnType<DeletionServiceFixture['request']>>;
  private source: Record<string, string> = {};
  private other = '';
  private otherLease = false;
  private workId = '';
  private workspaceParent = '';
  constructor(readonly id: string) {}
  async given(status = 'uncertain') {
    verifyForceRoomDeletionModel();
    this.host = await new DeletionServiceFixture().open();
    const f = this.host;
    await f.seedOperation(status); this.workId = f.context().intents[0]!.id;
    const otherTask = f.service.engine.submit(f.otherRoom, { id: 'same-message', text: '保留另一会话和同名任务' }).taskId!;
    const otherWork = f.service.engine.claim(f.otherRoom, otherTask, f.service.engine.pending(f.otherRoom, otherTask)[0]!.id)!;
    assert(f.service.engine.send(f.otherRoom, otherTask, { type: 'WAIT_USER', id: randomUUID(), at: Date.now(),
      workId: otherWork.id, fence: otherWork, question: '另一会话的独立等待' }).ok);
    if (!['running', 'cancelling'].includes(status)) {
      f.service.engine.store.transact(f.otherRoom, tx => { assert(tx.acquireWorkspace('other-room-exclusive', 'other-room-owner')); });
      this.otherLease = true;
    }
    this.source = await directorySnapshot(f.source);
    this.other = this.otherContent();
    await f.archive();
    if (this.id === 'BT_Y162') {
      const workspace = join(f.root, 'runtime', 'workspaces'); await mkdir(workspace, { recursive: true });
      await symlink(f.source, join(workspace, f.service.engine.localNamespace(f.room, f.task)), 'dir');
    }
    if (this.id === 'BT_Y163') {
      this.workspaceParent = join(f.root, 'runtime', 'workspaces');
      await mkdir(this.workspaceParent, { recursive: true });
      await rename(this.workspaceParent, this.workspaceParent + '.saved');
      await symlink(f.source, this.workspaceParent, 'dir');
    } else if (this.id === 'BT_Y164') {
      const saved = f.service.engine.requestRoomDeletion(f.room, 'old-safe-delete', f.service.rooms().find(r => r.id === f.room)!.archiveVersion!);
      const intent = saved.context.intents[0]!;
      const store = deletionStore(f.service.engine.store);
      const claim = store.stepDeletion(f.room, { type: 'CLAIM', id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!, intentId: intent.id });
      const tasks = [f.service.engine.view(f.room, f.task)!];
      const inventory = await f.runtime.planRoomCleanup({ roomId: f.room, tasks, quiescent: true });
      const waiting = store.stepDeletion(f.room, { type: 'PREPARED', id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!,
        intentId: intent.id, attempt: claim.context.intents[0]!.attempt, inventory });
      assert.equal(waiting.value, 'waiting');
      assert(waiting.context.blockers.length > 0);
    }
  }
  async act() {
    const f = this.host;
    if (this.id === 'BT_Y166') {
      const before = f.readRows();
      for (const [target, origin] of [[f.room, 'https://outside.invalid'], [randomUUID(), f.url], [f.otherRoom, f.url]] as const) {
        const response = await f.request(f.route(target) + '/delete', { id: randomUUID() }, { origin });
        assert([403, 404, 409].includes(response.status), JSON.stringify(response));
      }
      assert.deepEqual(f.readRows(), before);
      return;
    }
    this.result = await f.request(f.route() + '/delete', { id: randomUUID(),
      ...(this.id === 'BT_Y165' ? { expectedArchiveVersion: 0, expectedDeletionVersion: 0 } : {}) });
  }
  async verify() {
    const f = this.host;
    if (this.id === 'BT_Y166') { await this.preserved(); return; }
    assert.equal(this.result!.status, 202); assert.equal(this.result!.data.status, 'deleted');
    assert.equal(f.service.rooms().some(r => r.id === f.room), false);
    assert.equal(f.service.deletedRooms().some(r => r.roomId === f.room), true);
    const rows = f.readRows();
    assert.deepEqual(rows.rooms, []); assert.deepEqual(rows.receipts, []); assert.deepEqual(rows.webRooms, []); assert.deepEqual(rows.events, []);
    assert.deepEqual(deletionStore(f.service.engine.store).deletionLeases(f.room), []);
    assert.equal((await f.request(f.route())).status, 410);
    assert.equal(f.event({ type: 'DELIVER', workId: this.workId, text: '迟到结果不能复活', artifactIds: [] }).ok, false);
    assert.equal((await f.request(f.route() + '/delete', { id: randomUUID() })).data.status, 'deleted');
    if (this.id === 'BT_Y163') {
      const waiting = await deletionUntil(() => f.service.engine.roomDeletion(f.room), s => ['waiting', 'paused'].includes(s?.value ?? ''), 'automatic cleanup wait');
      assert.equal(waiting!.context.dataErased, true); assert(waiting!.context.nextWake);
      assert(waiting!.context.blockers.every(b => !b.human));
      await f.restart(true);
      assert(!f.service.rooms().some(r => r.id === f.room));
      await rm(this.workspaceParent); await rename(this.workspaceParent + '.saved', this.workspaceParent);
      await f.complete();
    } else await f.complete();
    await f.assertGone(); await this.preserved();
    if (this.id === 'BT_Y162') {
      // A fresh real command can now acquire the previously blocked shared runtime resource.
      const originalRoom = f.room, originalTask = f.task;
      f.room = f.service.createRoom('验证锁已释放').id;
      await f.seedOperation('succeeded');
      assert(f.context().intents.some(w => w.localOperations?.some(op => op.status === 'succeeded')));
      f.room = originalRoom; f.task = originalTask;
    }
  }
  private otherContent() {
    const room = this.host.service.engine.store.read(this.host.otherRoom);
    return JSON.stringify(Object.keys(room.tasks).map(id => {
      const c = this.host.service.engine.view(this.host.otherRoom, id)!.context;
      return { id, messages: c.messages, artifacts: c.artifacts, board: c.board, goal: c.goal, outcome: c.outcome };
    }));
  }
  async preserved() {
    const f = this.host;
    assert.deepEqual(await directorySnapshot(f.source), this.source);
    assert.equal(this.otherContent(), this.other);
    if (this.otherLease) assert(f.readRows().leases.some(row => row.key === 'other-room-exclusive' && row.owner === 'other-room-owner'));
  }
  async close() { await this.host?.close(); }
}
