import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RoomDeletionModel, deletionInventory, verification } from './room-deletion-model-fixture.js';

/** Enumerates ordering/recovery invariants against the production XState model, without I/O. */
export function verifyForceRoomDeletionModel() {
  const traces: { name: string; events: string[] }[] = [];
  for (const legacy of [false, true]) {
    const m = new RoomDeletionModel();
    const inventory = deletionInventory(undefined, true);
    inventory.executionsSettled = false;
    if (legacy) {
      m.request();
      m.prepared({ ...inventory, blockers: [{ id: 'unknown', kind: 'effects', human: true, reason: '旧操作未核对' }] });
      assert.equal(m.snapshot.value, 'waiting');
    }
    assert(m.request({ force: true, confirmed: false, expectedArchiveVersion: 0, inventory }).ok);
    assert.equal(m.snapshot.value, 'deleting');
    assert.equal(m.context.intents.find(i => i.status === 'pending')?.kind, 'eraseData');
    m.recover(); assert(m.erase().ok);
    assert.equal(m.context.dataErased, true);
    assert.equal(m.snapshot.value, 'preparing');
    m.recover(); assert(m.prepared(inventory).ok);
    assert.equal(m.snapshot.value, 'deleting');
    const oldClaim = m.claim('removeAsset');
    assert(m.send({ type: 'FAILED', deletionId: 'delete-A', intentId: oldClaim.id, attempt: oldClaim.attempt,
      reason: 'EACCES', retryAt: 200 }).ok);
    assert.equal(m.context.dataErased, true, 'Cleanup failure must not undo logical deletion');
    m.recover(200); assert(m.prepared(inventory).ok);
    assert.equal(m.send({ type: 'ASSET_REMOVED', deletionId: 'delete-A', intentId: oldClaim.id,
      attempt: oldClaim.attempt, assetId: oldClaim.assetId!, identityVerified: true, result: 'deleted' }).ok, false);
    const claim = m.claim('removeAsset');
    assert(m.send({ type: 'ASSET_REMOVED', deletionId: 'delete-A', intentId: claim.id, attempt: claim.attempt,
      assetId: claim.assetId!, identityVerified: false, forceRemoved: true, result: 'deleted' }).ok);
    assert(m.verify({ ...verification, executionsSettled: false }).ok, 'Unknown external effects require no human review');
    assert.equal(m.snapshot.value, 'deleted');
    assert.equal(m.context.dataErased, true);
    assert.deepEqual(m.context.tasks, []);
    assert(m.request({ force: true, inventory }).ok);
    assert.equal(m.snapshot.value, 'deleted');
    traces.push({ name: legacy ? 'upgrade-legacy-wait' : 'force-with-unsettled-effects', events: m.traces });
  }
  for (const rejected of [{ authorized: false }, { archived: false }, { roomId: 'room-B' }]) {
    const m = new RoomDeletionModel();
    assert.equal(m.request({ force: true, inventory: deletionInventory(), ...rejected }).ok, false);
    assert.equal(m.snapshot.value, 'idle'); assert.deepEqual(m.context.intents, []);
    traces.push({ name: 'boundary:' + JSON.stringify(rejected), events: m.traces });
  }
  const physical = new RoomDeletionModel(); physical.request({ force: true, inventory: deletionInventory() }); physical.erase();
  physical.prepared({ ...deletionInventory(), executionsSettled: false,
    blockers: [{ id: 'physical', kind: 'execution', human: false, reason: '已知进程尚未退出' }] });
  assert.equal(physical.snapshot.value, 'waiting'); assert.equal(physical.context.dataErased, true);
  assert.equal(physical.context.nextWake, 5100);
  traces.push({ name: 'known-process-auto-retry-after-data-erasure', events: physical.traces });
  const boundary = new RoomDeletionModel(); boundary.request({ force: true, inventory: deletionInventory() }); boundary.erase();
  const activeIntents = structuredClone(boundary.context.intents);
  assert(boundary.send({ type: 'RETRY', deletionId: 'delete-A' }).ok);
  assert.deepEqual(boundary.context.intents, activeIntents, 'Retry while active must not replace claimed/pending cleanup');
  boundary.prepared({ ...deletionInventory(), complete: false,
    blockers: [{ id: 'boundary', kind: 'ownership', human: true, reason: '运行目录暂不可用' }] });
  assert.equal(boundary.snapshot.value, 'waiting'); assert.equal(boundary.context.dataErased, true);
  assert.equal(boundary.context.blockers[0]!.human, false); assert.equal(boundary.context.nextWake, 5100);
  traces.push({ name: 'file-boundary-error-auto-retry-without-human-review', events: boundary.traces });
  return { model: createHash('sha256').update(readFileSync(new URL('../src/room-deletion.machine.ts', import.meta.url))).digest('hex'), traces };
}
if (process.argv[1]?.endsWith('force-room-deletion-model-fixture.ts')) console.log(JSON.stringify(verifyForceRoomDeletionModel(), null, 2));
