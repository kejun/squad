import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialRoomDeletion, persistRoomDeletion, restoreRoomDeletion, stepRoomDeletion, deletionStatus,
  type RoomDeletionEvent, type RuntimeCleanupInventory, type DeletionTaskFacts, type RuntimeCleanupAsset,
  type DeletionIntentKind, type DeletionVerification } from '../src/room-deletion.machine.js';
import type { Phase, Outcome } from '../src/types.js';

type EventBody<E = RoomDeletionEvent> = E extends RoomDeletionEvent ? Omit<E, 'id' | 'at'> & { at?: number } : never;
type Request = Extract<RoomDeletionEvent, { type: 'REQUEST' }>;
export const verification: DeletionVerification = { inventoryComplete: true, filesGone: true, databaseGone: true,
  executionsSettled: true, projectionsCleared: true, dependenciesPreserved: true };
export function deletionTask(phase: Phase = 'running', outcome: Outcome | null = null): DeletionTaskFacts {
  return { taskId: 'task:secret-history', namespace: 'a'.repeat(64), phase, outcome,
    workIds: ['work:old-epoch'], operationIds: ['operation:collision'] };
}
export function deletionInventory(tasks: DeletionTaskFacts[] = [deletionTask()], withAsset = false): RuntimeCleanupInventory {
  const assets: RuntimeCleanupAsset[] = withAsset ? [{ id: 'workspace-asset', kind: 'workspace',
    path: `workspaces/${tasks[0]!.namespace}`, owner: { roomId: 'room-A', taskId: tasks[0]!.taskId, namespace: tasks[0]!.namespace },
    identity: 'b'.repeat(64), status: 'pending' }] : [];
  return { tasks: structuredClone(tasks), sessions: [], assets, blockers: [], complete: true, executionsSettled: true };
}

export class RoomDeletionModel {
  snapshot = initialRoomDeletion({ roomId: 'room-A' });
  sequence = 0;
  traces: string[] = [];
  send(event: EventBody) {
    this.snapshot = restoreRoomDeletion(structuredClone(persistRoomDeletion(stepRoomDeletion(this.snapshot,
      { id: `event:${++this.sequence}`, at: 100, ...event } as RoomDeletionEvent))));
    this.traces.push(`${event.type}:${this.snapshot.value}`);
    return this.snapshot.context.reply;
  }
  request(overrides: Partial<Request> = {}) {
    return this.send({ type: 'REQUEST', roomId: 'room-A', deletionId: 'delete-A', requestDigest: 'a'.repeat(64),
      confirmed: true, authorized: true, archived: true, archiveVersion: 1, expectedArchiveVersion: 1,
      allTasks: [deletionTask()].map(({ taskId, namespace }) => ({ taskId, namespace })), ...overrides });
  }
  get context() { return this.snapshot.context; }
  claim(kind: DeletionIntentKind) {
    const intent = this.context.intents.find(item => item.kind === kind && item.status === 'pending');
    assert(intent, `No pending ${kind}: ${JSON.stringify(deletionStatus(this.snapshot))}`);
    assert(this.send({ type: 'CLAIM', deletionId: 'delete-A', intentId: intent.id }).ok);
    return this.context.intents.find(item => item.id === intent.id)!;
  }
  prepared(inventory = deletionInventory(), nextWake?: number) {
    const intent = this.claim('prepare');
    return this.send({ type: 'PREPARED', deletionId: 'delete-A', intentId: intent.id, attempt: intent.attempt, inventory,
      ...(nextWake === undefined ? {} : { nextWake }) });
  }
  remove() {
    const intent = this.claim('removeAsset');
    return this.send({ type: 'ASSET_REMOVED', deletionId: 'delete-A', intentId: intent.id, attempt: intent.attempt,
      assetId: intent.assetId!, identityVerified: true, result: 'deleted' });
  }
  erase() {
    const intent = this.claim('eraseData');
    return this.send({ type: 'DATA_ERASED', deletionId: 'delete-A', intentId: intent.id, attempt: intent.attempt });
  }
  verify(checks = verification) {
    const intent = this.claim('verify');
    return this.send({ type: 'VERIFIED', deletionId: 'delete-A', intentId: intent.id, attempt: intent.attempt, checks });
  }
  recover(at = 100) { return this.send({ type: 'RECOVER', deletionId: 'delete-A', at }); }
  finish() {
    assert(this.erase().ok); assert(this.verify().ok); assert.equal(this.snapshot.value, 'deleted');
  }
}
export function verifyRoomDeletionModel() {
  const traces: { name: string; events: string[] }[] = [];
  const save = (name: string, model: RoomDeletionModel) => traces.push({ name, events: model.traces });
  const invalidRequests: Partial<Request>[] = [{ confirmed: false }, { authorized: false }, { archived: false },
    { archiveVersion: 2 }, { roomId: 'room-B' }, { allTasks: [{ taskId: 'bad', namespace: 'not-hash' }] },
    { allTasks: [deletionTask(), deletionTask()] }];
  for (const invalid of invalidRequests) {
    const model = new RoomDeletionModel(); assert.equal(model.request(invalid).ok, false);
    assert.equal(model.snapshot.value, 'idle'); assert.deepEqual(model.context.intents, []); save('invalid-request:' + JSON.stringify(invalid), model);
  }
  const taskCases: [Phase, Outcome | null][] = [['interpreting', null], ['running', null], ['waitingAssistance', null],
    ['coordinating', null], ['waitingHuman', null], ['checking', null], ['stopping', null],
    ['ended', 'complete'], ['ended', 'partial'], ['ended', 'failed'], ['ended', 'stopped']];
  for (const [phase, outcome] of taskCases) {
    const model = new RoomDeletionModel(); assert(model.request().ok);
    assert.equal(model.snapshot.value, 'preparing', 'Confirmed archived deletion must persist its barrier and preparation intent');
    assert(model.prepared(deletionInventory([deletionTask(phase, outcome)], true)).ok);
    assert.equal(model.snapshot.value, 'deleting'); assert(model.remove().ok); model.finish();
    assert.equal(deletionStatus(model.snapshot).remaining, 0);
    assert(!JSON.stringify(persistRoomDeletion(model.snapshot)).includes('secret-history'), 'Tombstone must remove task/session/resource material');
    save('phase:' + phase + ':' + outcome, model);
  }
  const empty = new RoomDeletionModel(); empty.request({ allTasks: [] }); empty.prepared(deletionInventory([])); empty.finish(); save('empty-room', empty);
  const historical = new RoomDeletionModel();
  const old = { ...deletionTask('ended', 'partial'), taskId: 'old-task', namespace: 'c'.repeat(64) };
  historical.request({ allTasks: [deletionTask(), old] }); historical.prepared(deletionInventory([deletionTask(), old])); historical.finish();
  save('all-historical-non-active-tasks', historical);
  const incomplete = new RoomDeletionModel(); incomplete.request(); assert.equal(incomplete.prepared(deletionInventory([])).ok, false);
  assert.equal(incomplete.snapshot.value, 'paused'); save('omitted-historical-task-rejected', incomplete);

  for (const kind of ['effects', 'ownership', 'dependency'] as const) {
    const model = new RoomDeletionModel(); model.request(); const inventory = deletionInventory([], false);
    inventory.tasks = [deletionTask()]; inventory.complete = kind !== 'ownership'; inventory.executionsSettled = kind !== 'effects';
    inventory.blockers = [{ id: 'blocker', kind, reason: '未决真实责任', human: kind !== 'effects' }];
    assert(model.prepared(inventory).ok); assert.equal(model.snapshot.value, 'waiting');
    assert(!model.context.intents.some(intent => intent.kind === 'removeAsset'));
    const wake = model.context.nextWake;
    if (kind === 'effects') {
      assert(wake !== null); model.send({ type: 'TICK', deletionId: 'delete-A', at: wake - 1 }); assert.equal(model.snapshot.value, 'waiting');
      model.recover(wake); assert.equal(model.snapshot.value, 'preparing');
    } else {
      assert.equal(wake, null); model.recover(1_000_000); assert.equal(model.snapshot.value, 'waiting');
      model.send({ type: 'TICK', deletionId: 'delete-A', at: 2_000_000 }); assert.equal(model.snapshot.value, 'waiting');
      model.send({ type: 'RETRY', deletionId: 'delete-A' });
    }
    assert(model.prepared(deletionInventory()).ok); model.finish(); save('blocker:' + kind, model);
  }

  const invalidAssets: Partial<RuntimeCleanupAsset>[] = [
    { path: '../outside' }, { path: '/etc/passwd' }, { path: 'skills/' + 'a'.repeat(64) },
    { owner: { roomId: 'room-B', taskId: deletionTask().taskId, namespace: deletionTask().namespace } },
    { owner: { roomId: 'room-A', taskId: deletionTask().taskId, namespace: deletionTask().namespace, workId: 'forged-work' } },
  ];
  for (const invalid of invalidAssets) {
    const model = new RoomDeletionModel(); model.request(); const inventory = deletionInventory(undefined, true);
    Object.assign(inventory.assets[0]!, invalid); assert.equal(model.prepared(inventory).ok, false);
    assert.equal(model.snapshot.value, 'paused'); save('untrusted-asset:' + JSON.stringify(invalid), model);
  }

  const sessionModel = new RoomDeletionModel(); sessionModel.request();
  const inventory = deletionInventory(undefined, true);
  inventory.sessions = ['old-session', 'new-session'].map((sessionId, index) => ({ roomId: 'room-A', taskId: deletionTask().taskId,
    namespace: deletionTask().namespace, workId: deletionTask().workIds[0]!, operationId: deletionTask().operationIds[0]!,
    parentAttempt: 1, attempt: index + 1, sessionId }));
  inventory.assets.push(...inventory.sessions.map((owner, index) => ({ id: 'journal:' + owner.sessionId, kind: 'journal' as const,
    path: `sessions/${String(index + 1).repeat(64)}.json`, owner, identity: 'f'.repeat(64), status: 'pending' as const })));
  assert(sessionModel.prepared(inventory).ok); assert.equal(sessionModel.context.sessions.length, 2);
  sessionModel.remove(); sessionModel.remove(); sessionModel.remove(); sessionModel.finish(); save('all-historical-sessions', sessionModel);

  const stale = new RoomDeletionModel(); stale.request(); const oldClaim = stale.claim('prepare'); stale.recover();
  const newClaim = stale.claim('prepare'); assert.equal(newClaim.attempt, oldClaim.attempt + 1);
  assert.equal(stale.send({ type: 'PREPARED', deletionId: 'delete-A', intentId: oldClaim.id, attempt: oldClaim.attempt, inventory: deletionInventory() }).ok, false);
  assert.equal(stale.snapshot.value, 'preparing');
  assert(stale.send({ type: 'PREPARED', deletionId: 'delete-A', intentId: newClaim.id, attempt: newClaim.attempt, inventory: deletionInventory() }).ok);
  stale.finish(); save('stale-recovered-claim', stale);

  const identity = new RoomDeletionModel(); identity.request(); identity.prepared(deletionInventory(undefined, true));
  const assetClaim = identity.claim('removeAsset');
  assert.equal(identity.send({ type: 'ASSET_REMOVED', deletionId: 'delete-A', intentId: assetClaim.id, attempt: assetClaim.attempt,
    assetId: assetClaim.assetId!, identityVerified: false, result: 'deleted' }).ok, false);
  assert.equal(identity.snapshot.value, 'paused'); assert.equal(identity.context.assets[0]!.status, 'pending'); save('unconfirmed-removal-pauses', identity);

  for (const check of Object.keys(verification) as (keyof DeletionVerification)[]) {
    const model = new RoomDeletionModel(); model.request(); model.prepared(); model.erase();
    assert.equal(model.verify({ ...verification, [check]: false }).ok, false);
    assert.equal(model.snapshot.value, 'paused'); assert.equal(model.context.completedAt, null); save('verification:' + check, model);
  }
  const erasedRetry = new RoomDeletionModel(); erasedRetry.request(); erasedRetry.prepared(); erasedRetry.erase();
  const originalDeletionId = erasedRetry.context.deletionId;
  assert.equal(erasedRetry.verify({ ...verification, projectionsCleared: false }).ok, false);
  assert.equal(erasedRetry.snapshot.value, 'paused'); assert.equal(erasedRetry.context.dataErased, true);
  assert(erasedRetry.send({ type: 'RETRY', deletionId: originalDeletionId! }).ok);
  assert.equal(erasedRetry.context.dataErased, true); assert.equal(erasedRetry.context.deletionId, originalDeletionId);
  assert(erasedRetry.prepared().ok);
  assert.equal(erasedRetry.snapshot.value, 'deleting'); assert.equal(erasedRetry.context.dataErased, true);
  assert.deepEqual(erasedRetry.context.intents.filter(intent => ['pending', 'claimed'].includes(intent.status)).map(intent => intent.kind), ['verify']);
  assert(erasedRetry.verify().ok); assert.equal(erasedRetry.snapshot.value, 'deleted');
  assert.equal(erasedRetry.context.dataErased, true); assert.equal(erasedRetry.context.deletionId, originalDeletionId);
  save('retry-after-data-erased-preserves-original-deletion', erasedRetry);
  for (const boundary of ['prepare', 'removeAsset', 'eraseData', 'verify'] as const) {
    const model = new RoomDeletionModel(); model.request();
    if (boundary !== 'prepare') model.prepared(deletionInventory(undefined, boundary === 'removeAsset'));
    if (boundary === 'verify') model.erase();
    const claim = model.claim(boundary); model.recover();
    const next = model.claim(boundary); assert.equal(next.attempt, claim.attempt + 1);
    if (boundary === 'prepare') model.send({ type: 'PREPARED', deletionId: 'delete-A', intentId: next.id, attempt: next.attempt, inventory: deletionInventory() });
    if (boundary === 'removeAsset') model.send({ type: 'ASSET_REMOVED', deletionId: 'delete-A', intentId: next.id, attempt: next.attempt,
      assetId: next.assetId!, identityVerified: true, result: 'absent' });
    if (boundary === 'eraseData') model.send({ type: 'DATA_ERASED', deletionId: 'delete-A', intentId: next.id, attempt: next.attempt });
    if (boundary === 'verify') model.send({ type: 'VERIFIED', deletionId: 'delete-A', intentId: next.id, attempt: next.attempt, checks: verification });
    if (!model.context.dataErased) model.erase();
    if (model.snapshot.value !== 'deleted') model.verify();
    assert.equal(model.snapshot.value, 'deleted'); save('recovery-boundary:' + boundary, model);
  }

  const duplicate = new RoomDeletionModel(); duplicate.request(); const before = persistRoomDeletion(duplicate.snapshot);
  assert(duplicate.request({ deletionId: 'another-server-id' }).ok);
  assert.equal(duplicate.context.deletionId, 'delete-A'); assert.equal(duplicate.context.intents.length, before.context.intents.length);
  duplicate.prepared(); duplicate.finish(); const tombstone = persistRoomDeletion(duplicate.snapshot);
  duplicate.recover(); assert.equal(duplicate.snapshot.value, 'deleted');
  assert.equal(duplicate.send({ type: 'CLAIM', deletionId: 'delete-A', intentId: 'old-intent' }).ok, false);
  assert.deepEqual(duplicate.context.assets, []); assert.deepEqual(duplicate.context.intents, []);
  assert.deepEqual(duplicate.context.allTasks, []); assert.deepEqual(duplicate.context.sessions, []);
  assert.equal(duplicate.context.completedAt, tombstone.context.completedAt); save('absorbing-minimal-tombstone', duplicate);
  const preparingIo = new RoomDeletionModel(); preparingIo.request();
  const pendingIo = deletionInventory(); pendingIo.executionsSettled = false;
  pendingIo.blockers.push({ id: 'runtime-preparation', kind: 'execution', reason: '逻辑运行器已退役，真实准备仍在执行', human: false });
  preparingIo.prepared(pendingIo); assert.equal(preparingIo.snapshot.value, 'waiting');
  assert(!preparingIo.context.intents.some(intent => intent.kind === 'removeAsset'));
  preparingIo.send({ type: 'TICK', deletionId: 'delete-A', at: preparingIo.context.nextWake! });
  preparingIo.prepared(deletionInventory(undefined, true)); preparingIo.remove(); preparingIo.finish();
  save('physical-preparation-outlives-logical-runner', preparingIo);
  return { model: createHash('sha256').update(readFileSync(new URL('../src/room-deletion.machine.ts', import.meta.url))).digest('hex'),
    cases: traces.length, transitions: traces.reduce((count, trace) => count + trace.events.length, 0), traces };
}
if (process.argv[1]?.endsWith('room-deletion-model-fixture.ts')) console.log(JSON.stringify(verifyRoomDeletionModel(), null, 2));
