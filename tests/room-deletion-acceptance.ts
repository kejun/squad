import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { RoomDeletionError, SqliteStore, MemoryStore, roomTaskNamespace, deletionStore, type DeletionStore } from '../src/store.js';
import type { Intent, Phase, Outcome, TaskEvent, TeamConfig } from '../src/types.js';
import type { LocalOperation, LocalAction } from '../src/local-operation.js';
import { persistRoomDeletion, restoreRoomDeletion, type RuntimeCleanupInventory, type SavedRoomDeletion, type RoomDeletionEvent } from '../src/room-deletion.machine.js';
import { ControlledProcessBackend, localConfig, writeSkill, removeFixture } from './local-tools-fixture.js';
import { Harness, passFixtureCheck } from './helpers.js';
import { verification } from './room-deletion-model-fixture.js';
import { RuntimeOwnership } from '../src/runtime-ownership.js';

export async function deletionUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Deletion did not reach ${label}`);
}
export async function directorySnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(folder: string, prefix: string) {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name), key = prefix + name, stat = await lstat(path);
      if (stat.isDirectory()) { result[key + '/'] = 'directory'; await walk(path, key + '/'); }
      else if (stat.isSymbolicLink()) result[key] = 'symbolic-link';
      else result[key] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(root, ''); return result;
}

/** Public service/HTTP/SQLite and real temporary files. The injected backend claims no OS sandbox. */
export class DeletionServiceFixture {
  root = ''; database = ''; source = ''; runtime!: LocalRuntime; service!: WebService; server!: Server; url = '';
  room = ''; otherRoom = ''; task = ''; sequence = 0; calls = 0;
  readonly backend = new ControlledProcessBackend();
  readonly config: TeamConfig = localConfig();
  operation?: { work: Intent; op: LocalOperation };
  private started = false;
  private operationMode = '';
  async open(mode = '', sharedSource = true, withSkill = false) {
    this.operationMode = mode;
    this.root = await mkdtemp(join(tmpdir(), 'squad-delete-acceptance-')); this.database = join(this.root, 'team.sqlite');
    this.source = join(this.root, 'source'); await mkdir(join(this.source, '.home'), { recursive: true });
    await mkdir(join(this.source, '.tmp')); await writeFile(join(this.source, 'user-source.txt'), 'shared user source');
    await writeFile(join(this.source, '.home', 'account.txt'), 'shared account must remain');
    await writeFile(join(this.source, '.tmp', 'user.txt'), 'shared temporary source');
    if (withSkill) await writeSkill(join(this.root, 'skills'));
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.root, 'runtime'), ...(sharedSource ? { workspaceRoot: this.source } : {}), skillRoots: withSkill ? [join(this.root, 'skills')] : [], backend: this.backend });
    this.config.limits.workTimeoutMs = 60_000; this.config.limits.progressIntervalMs = 60_000;
    this.config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 10_000, cancelGraceMs: 1000 };
    await this.start(); this.room = this.service.createRoom('删除目标').id; this.otherRoom = this.service.createRoom('保留目标').id;
    return this;
  }
  private async start() {
    this.service = new WebService(this.config, this.database, { execute: async (work, signal, scope) => {
      this.calls++;
      if (this.operationMode === 'running' && work.kind === 'owner') {
        const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "require('fs').writeFileSync('external-effect.txt','once');setInterval(()=>{},1000)"] };
        await scope.localTools!.invoke(action, [{ role: 'assistant', content: JSON.stringify(action) }], signal);
      }
      return { type: 'askUser', question: '保留当前已知资料，等待用户处理' };
    } }, undefined, true, this.runtime);
    await this.service.ready(); this.server = createWebServer(this.service);
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port; this.started = true;
  }
  async request(path: string, data?: unknown, options: { method?: string; origin?: string | null } = {}) {
    const response = await fetch(this.url + path, { method: options.method ?? (data === undefined ? 'GET' : 'POST'),
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.origin === null ? {} : { origin: options.origin ?? this.url }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  route(room = this.room) { return '/api/rooms/' + room; }
  event(body: Omit<TaskEvent, 'id' | 'at'> | Record<string, unknown>, task = this.task, room = this.room) {
    return this.service.engine.send(room, task, { id: `delete-fixture:${++this.sequence}`, at: Date.now(), ...body } as TaskEvent);
  }
  context() { return this.service.engine.view(this.room, this.task)!.context; }
  async seedPhase(phase: Phase = 'running', outcome: Outcome | null = null, id = 'same-message') {
    if (phase === 'interpreting') this.config.inputAnalysis = { enabled: true };
    const result = this.service.engine.submit(this.room, { id, text: '比较两个方案并说明成本和恢复风险；保留资料来源；交付Markdown报告',
      ...(phase === 'interpreting' ? {} : { goal: { text: '保留真实已有内容并安全删除', constraints: [], criteria: [], requiredArtifacts: 0 } }) });
    assert(result.ok, result.code); this.task = result.taskId!;
    if (phase === 'interpreting') { assert.equal(this.service.engine.view(this.room, this.task)!.phase, phase); return; }
    if (phase === 'running' && outcome === null) return;
    const owner = this.service.engine.claim(this.room, this.task, this.service.engine.pending(this.room, this.task)[0]!.id)!;
    assert(owner);
    if (phase === 'waitingAssistance') assert(this.event({ type: 'HELP', workId: owner.id, fence: owner, caller: owner.target,
      target: 'B', requestId: 'help', question: '核对现有材料', expected: '具体结果' }).ok);
    if (phase === 'coordinating') assert(this.event({ type: 'BLOCKED', workId: owner.id, fence: owner, reason: '需要调整执行方式' }).ok);
    if (phase === 'waitingHuman') assert(this.event({ type: 'WAIT_USER', workId: owner.id, fence: owner, question: '请确认处理方式' }).ok);
    if (phase === 'checking' || outcome === 'complete') {
      assert(this.event({ type: 'DELIVER', workId: owner.id, fence: owner, text: '已有可核对的成果', artifactIds: [],
        artifacts: [{ name: 'completed.md', content: '已有可核对的成果' }] }).ok);
      if (outcome === 'complete') passFixtureCheck(this.service.engine, this.room, this.task, randomUUID(), Date.now());
    }
    if (phase === 'stopping' || outcome === 'stopped') {
      assert(this.event({ type: 'STOP' }).ok);
      if (outcome === 'stopped') assert(this.event({ type: 'SETTLE', intentId: owner.id }).ok);
    }
    if (outcome === 'partial' || outcome === 'failed') {
      if (outcome === 'partial') assert(this.event({ type: 'ARTIFACT', artifact: { id: 'partial:' + id, name: 'partial.md', content: '已经完成的可信部分' } }).ok);
      assert(this.event({ type: 'EXHAUSTED', reason: '受控的已有终态前缀' }).ok);
    }
    assert.equal(this.service.engine.view(this.room, this.task)!.phase, phase);
    if (outcome !== null) assert.equal(this.context().outcome, outcome);
  }
  async seedOperation(status: string) {
    if (status === 'running' || status === 'cancelling') {
      this.operationMode = 'running';
      const result = this.service.submit(this.room, { id: 'same-message', text: '执行后安全处理' }); this.task = result.taskId!;
      await deletionUntil(() => this.context().intents.flatMap(work => work.localOperations ?? []).some(op => op.status === 'running'), Boolean, 'real CLI running');
      await deletionUntil(async () => {
        const op = this.context().intents.flatMap(work => work.localOperations ?? []).find(op => op.status === 'running');
        if (!op?.sessionId) return false;
        const record = await this.runtime.journal.read(op.sessionId);
        try { return record?.phase === 'spawned' && !!record.identity && await readFile(join(this.source, 'external-effect.txt'), 'utf8') === 'once'; }
        catch { return false; }
      }, Boolean, 'actual process identity and external effect');
      if (status === 'cancelling') { this.service.stop(this.room, this.task, 'stop-before-delete');
        assert(this.context().intents.flatMap(work => work.localOperations ?? []).some(op => op.status === 'cancelling')); }
      return;
    }
    await this.seedPhase();
    const work = this.service.engine.claim(this.room, this.task, this.service.engine.pending(this.room, this.task)[0]!.id)!;
    const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', status === 'failed' ? 'process.exit(7)' : "console.log('known output')"],
      ...(status === 'awaitingApproval' ? { execution: 'host', reason: '明确准备但尚未批准' } : {}) };
    const request = this.service.engine.requestLocal(this.room, this.task, work.id, work.attempt, action, [],
      this.runtime.workspaceId(work, this.service.engine.localNamespace(this.room, this.task)));
    if (status === 'queued' || status === 'cancelled') {
      if (status === 'cancelled') assert(this.event({ type: 'STOP' }).ok);
      return;
    }
    const claim = this.service.engine.claimLocal(this.room, this.task, work.id, request.id, work.attempt); assert(claim.response.ok);
    const op = claim.operation!; this.operation = { work, op };
    if (status === 'claimed') return;
    const execution = await this.runtime.execute(work, op, new AbortController().signal, metadata => {
      assert(this.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...metadata }).ok);
    }, undefined, { roomId: this.room, taskId: this.task });
    if (execution.approval) {
      assert(this.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, approval: execution.approval }).ok); return;
    }
    if (status === 'uncertain') await this.runtime.journal.write({ operationId: op.id, sessionId: op.sessionId!, phase: 'settled', completion: { ...execution, effectsKnown: false } });
    assert(this.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...execution,
      ...(status === 'uncertain' ? { effectsKnown: false } : {}) }).ok);
    assert.equal(this.context().intents.flatMap(value => value.localOperations ?? []).find(value => value.id === op.id)!.status, status);
  }
  async archive() { return this.service.setRoomArchived(this.room, 'archive:' + randomUUID(), true); }
  async delete() {
    const room = this.service.rooms().find(room => room.id === this.room)!;
    return this.request(this.route() + '/delete', { id: 'delete:' + randomUUID(), expectedArchiveVersion: room.archiveVersion });
  }
  async state() { return this.service.engine.roomDeletion(this.room); }
  async complete() { return deletionUntil(() => this.service.engine.roomDeletion(this.room), saved => saved?.value === 'deleted', 'deleted'); }
  async reviewUnknown() {
    const view = this.service.engine.view(this.room, this.task)!;
    for (const work of view.context.intents) for (const op of work.localOperations ?? []) if (op.status === 'uncertain') {
      const review = await deletionUntil(() => this.runtime.reviewOperation(work, op), review => review.processState === 'exited', 'actual cancelled process exit');
      const result = await this.request(this.route() + '/operation-reconcile', { id: 'review:' + randomUUID(), taskId: this.task,
        workId: work.id, operationId: op.id, reviewDigest: review.reviewDigest });
      assert.equal(result.status, 200, JSON.stringify(result.data));
    }
    const saved = this.service.engine.roomDeletion(this.room)!;
    assert.equal((await this.request(this.route() + '/delete-retry', { id: 'retry:' + randomUUID(), deletionId: saved.context.deletionId,
      expectedDeletionVersion: saved.context.revision })).status, 202);
    await this.complete();
  }
  readRows() {
    const db = new DatabaseSync(this.database, { readOnly: true });
    try {
      return { rooms: db.prepare('SELECT id,data FROM rooms WHERE id=?').all(this.room),
        receipts: db.prepare('SELECT * FROM receipts WHERE room_id=?').all(this.room),
        webRooms: db.prepare('SELECT * FROM web_rooms WHERE id=?').all(this.room),
        events: db.prepare('SELECT * FROM web_events WHERE roomId=?').all(this.room),
        deletion: db.prepare('SELECT data FROM room_deletions WHERE room_id=?').get(this.room),
        leases: db.prepare('SELECT * FROM workspace_leases').all() };
    } finally { db.close(); }
  }
  async restart(recreateRuntime = false) {
    await new Promise<void>(resolve => this.server.close(() => resolve())); await this.service.close(); this.started = false;
    if (recreateRuntime) { const options = this.runtime.options; await this.runtime.close(); this.runtime = await LocalRuntime.create(options); }
    await this.start();
  }
  async assertGone() {
    await this.complete();
    const rows = this.readRows(); assert.deepEqual(rows.rooms, []); assert.deepEqual(rows.receipts, []);
    assert.deepEqual(rows.webRooms, []); assert.deepEqual(rows.events, []);
    const tombstone = JSON.stringify(rows.deletion); assert(!tombstone.includes('已有') && !tombstone.includes('operation:') && !tombstone.includes('logs/'));
    assert.equal((await this.request(this.route())).status, 410);
    assert.equal((await this.request('/api/debug/rooms/' + this.room)).status, 410);
    assert(this.service.rooms().some(room => room.id === this.otherRoom));
  }
  async close() {
    if (this.started) { await new Promise<void>(resolve => this.server.close(() => resolve())); await this.service.close(); this.started = false; }
    await this.runtime?.close(); if (this.root) await removeFixture(this.root);
  }
}

export async function deletionMemoryServiceAcceptance(): Promise<Record<string, unknown>> {
  const connections = new Set<DatabaseSync>(), originalExec = DatabaseSync.prototype.exec;
  let service: WebService | undefined, server: Server | undefined;
  const config = localConfig(); config.inputAnalysis = { enabled: false };
  config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
  try {
    // Observe Node's public SQLite dependency without replacing any statement or result.
    // Capture only the synchronous constructor, and restore even if construction fails.
    try {
      DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) { connections.add(this); return originalExec.call(this, sql); };
      service = new WebService(config, ':memory:', { execute: async () => ({ type: 'askUser', question: '内存任务等待用户明确决定' }) }, undefined, true);
    } finally { DatabaseSync.prototype.exec = originalExec; }
    await service.ready();
    assert.equal(connections.size, 1, 'Store and Web projections must use one actual SQLite memory connection');
    const database = [...connections][0]!;
    assert.equal(database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file, '', 'The integration must use actual SQLite memory, not a temporary database file');
    let closed = 0; const originalClose = database.close.bind(database);
    database.close = () => { closed++; originalClose(); };
    const rows = (roomId: string) => ({
      rooms: database.prepare('SELECT id,data FROM rooms WHERE id=?').all(roomId),
      receipts: database.prepare('SELECT * FROM receipts WHERE room_id=? ORDER BY id').all(roomId),
      webRooms: database.prepare('SELECT * FROM web_rooms WHERE id=?').all(roomId),
      events: database.prepare('SELECT * FROM web_events WHERE roomId=? ORDER BY id').all(roomId),
    });
    server = createWebServer(service); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const request = async (path: string, data?: unknown) => {
      const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(8000),
        headers: { origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    assert.equal((await request('/api/health')).status, 200);
    const targetReply = await request('/api/rooms', { title: '内存待删除目标' }), foreignReply = await request('/api/rooms', { title: '内存独立保留目标' });
    assert.equal(targetReply.status, 201); assert.equal(foreignReply.status, 201);
    const target = String(targetReply.data.id), foreign = String(foreignReply.data.id), route = '/api/rooms/' + target;
    for (const roomId of [target, foreign]) {
      const submitted = await request('/api/rooms/' + roomId + '/messages', { id: 'same-memory-message', text: '保留实际内存任务与网页执行证据' });
      assert.equal(submitted.status, 200);
      await deletionUntil(() => service!.snapshot(roomId).tasks, tasks => tasks.some(task => task.phase === 'waitingHuman'), 'memory task and public Web events');
      const stored = rows(roomId); assert(stored.rooms.length); assert(stored.receipts.length); assert(stored.webRooms.length); assert(stored.events.length);
    }
    const beforeOther = rows(foreign);
    const archived = await request(route + '/archive', { id: 'memory-archive' }); assert.equal(archived.status, 200);
    const confirmation = { id: 'memory-delete', expectedArchiveVersion: archived.data.archiveVersion };
    assert.equal((await request(route + '/delete', confirmation)).status, 202);
    await deletionUntil(() => service!.engine.roomDeletion(target), saved => saved?.value === 'deleted', 'memory deletion completed in the same database');
    assert.deepEqual(rows(target), { rooms: [], receipts: [], webRooms: [], events: [] });
    assert.deepEqual(rows(foreign), beforeOther);
    const gone = await request(route); assert.equal(gone.status, 410); assert.equal(gone.data.code, 'ROOM_DELETED');
    assert.equal((await request('/api/debug/rooms/' + target)).status, 410);
    const list = await request('/api/rooms'); assert.equal(list.status, 200);
    assert(!(list.data.rooms as { id: string }[]).some(room => room.id === target));
    assert((list.data.rooms as { id: string }[]).some(room => room.id === foreign));
    assert.equal((await request(route + '/delete', confirmation)).status, 202);
    assert.equal((await request(route + '/messages', { id: 'late-memory-input', text: '不得复活' })).status, 410);
    assert.equal((await request(route + '/restore', { id: 'late-memory-restore' })).status, 410);
    assert.equal((await request(route)).status, 410); assert.equal((await request('/api/health')).status, 200);
    assert.deepEqual(rows(target), { rooms: [], receipts: [], webRooms: [], events: [] }); assert.deepEqual(rows(foreign), beforeOther);
    const tombstone = database.prepare('SELECT data FROM room_deletions WHERE room_id=?').get(target) as { data: string };
    assert.equal(JSON.parse(tombstone.data).value, 'deleted'); assert(!tombstone.data.includes('内存待删除目标'));
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    await service.close(); await service.close();
    assert.equal(closed, 1, 'The service owns the shared connection; borrowed Store close cannot close it twice');
    assert.throws(() => database.prepare('SELECT 1'), /not open|closed/i);
    return { deleted: true, actualSQLiteMemory: true, connections: connections.size, targetTablesGone: 4, foreignRowsPreserved: true,
      httpGone: true, lateRequestsRejected: true, sharedConnectionClosedOnce: true };
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (service) await service.close();
    else for (const database of connections) { try { database.close(); } catch { /* Failed construction may have already released it. */ } }
  }
}

/** Exercise the exact Store transaction boundary with both adapters; filesystem safety has its own fixture. */
export async function deletionStoreAcceptance(storage: 'Memory' | 'SQLite') {
  const root = await mkdtemp(join(tmpdir(), 'squad-delete-store-'));
  const store = storage === 'Memory' ? new MemoryStore() : new SqliteStore(join(root, 'team.sqlite'));
  const h = new Harness(undefined, store);
  try {
    assert(h.engine.setRoomArchived(h.room, 'archive', true).ok);
    const other = h.engine.submit('other-room', { id: 'M1', text: '必须保留' }); assert(other.ok);
    const beforeOther = store.read('other-room');
    let saved = store.stepDeletion(h.room, { type: 'REQUEST', id: 'delete', at: 1, roomId: h.room, deletionId: 'delete-store',
      requestDigest: 'a'.repeat(64), confirmed: true, authorized: true, archived: true, archiveVersion: 1, expectedArchiveVersion: 1,
      allTasks: [{ taskId: h.task, namespace: roomTaskNamespace(h.room, h.task) }] });
    assert.equal(saved.value, 'preparing');
    assert.throws(() => store.transact(h.room, tx => { tx.room.notices.push({ id: 'late', text: '不能复活' }); }), RoomDeletionError);
    const claim = (kind: string, at = 2) => {
      const intent = saved.context.intents.find(intent => intent.kind === kind && intent.status === 'pending')!; assert(intent);
      saved = store.stepDeletion(h.room, { type: 'CLAIM', id: randomUUID(), at, deletionId: 'delete-store', intentId: intent.id });
      return saved.context.intents.find(item => item.id === intent.id)!;
    };
    const prepare = claim('prepare');
    store.transactDeletionSettlement(h.room, { deletionId: 'delete-store', intentId: prepare.id, attempt: prepare.attempt }, tx => { tx.room.notices = []; });
    assert.throws(() => store.transactDeletionSettlement(h.room, { deletionId: 'delete-store', intentId: prepare.id, attempt: prepare.attempt + 1 }, () => {}), RoomDeletionError);
    saved = store.stepDeletion(h.room, { type: 'PREPARED', id: randomUUID(), at: 3, deletionId: 'delete-store', intentId: prepare.id, attempt: prepare.attempt,
      inventory: { tasks: [{ taskId: h.task, namespace: roomTaskNamespace(h.room, h.task), phase: h.view().phase, outcome: h.context().outcome,
        workIds: h.context().intents.map(work => work.id), operationIds: [] }], sessions: [], assets: [], complete: true, executionsSettled: true, blockers: [] } });
    const erase = claim('eraseData', 4);
    const erasedEvent: Extract<RoomDeletionEvent, { type: 'DATA_ERASED' }> = { type: 'DATA_ERASED', id: 'erase', at: 5,
      deletionId: 'delete-store', intentId: erase.id, attempt: erase.attempt };
    const before = store.read(h.room); store.failNextCommit = true;
    assert.throws(() => store.eraseDeletionData(h.room, erasedEvent), /Injected commit failure/);
    assert.deepEqual(store.read(h.room), before); assert.equal(store.readDeletion(h.room)!.context.dataErased, false);
    saved = store.eraseDeletionData(h.room, erasedEvent); assert(store.verifyDeletionDataGone(h.room));
    const verify = claim('verify', 6);
    saved = store.stepDeletion(h.room, { type: 'FAILED', id: 'projection-not-yet-clear', at: 7, deletionId: 'delete-store',
      intentId: verify.id, attempt: verify.attempt, reason: 'DELETION_PROJECTION_REMAINS' });
    saved = store.stepDeletion(h.room, { type: 'RETRY', id: 'retry-after-data-erasure', at: 8, deletionId: 'delete-store' });
    const retryPrepare = claim('prepare', 9); let invoked = false;
    assert.throws(() => store.transactDeletionSettlement(h.room, { deletionId: 'delete-store', intentId: retryPrepare.id, attempt: retryPrepare.attempt }, tx => {
      invoked = true; tx.room.notices.push({ id: 'late-prepare', text: '不得在清库后重建房间' });
    }), error => error instanceof RoomDeletionError && error.code === 'DELETION_DATA_ERASED');
    assert.equal(invoked, false); assert(store.verifyDeletionDataGone(h.room));
    h.engine.prepareRoomDeletion(h.room, 'delete-store', retryPrepare, true);
    assert(h.engine.healthy); assert(store.verifyDeletionDataGone(h.room));
    saved = store.stepDeletion(h.room, { type: 'PREPARED', id: 'prepared-after-data-erasure', at: 10, deletionId: 'delete-store',
      intentId: retryPrepare.id, attempt: retryPrepare.attempt,
      inventory: { tasks: saved.context.tasks, sessions: [], assets: [], complete: true, executionsSettled: true, blockers: [] } });
    assert(saved.context.dataErased);
    assert.deepEqual(saved.context.intents.filter(intent => ['pending', 'claimed'].includes(intent.status)).map(intent => intent.kind), ['verify']);
    const finalVerify = claim('verify', 11);
    saved = store.finishRoomDeletion(h.room, { type: 'VERIFIED', id: 'verified', at: 12, deletionId: 'delete-store', intentId: finalVerify.id, attempt: finalVerify.attempt, checks: verification });
    assert.equal(saved.value, 'deleted'); assert.deepEqual(saved.context.allTasks, []); assert.deepEqual(saved.context.intents, []);
    assert.deepEqual(store.read('other-room'), beforeOther);
    assert.throws(() => store.transact(h.room, tx => tx.remember('late', 'hash', 'content')), error => error instanceof RoomDeletionError && error.code === 'ROOM_DELETED');
    assert.deepEqual(store.read('other-room'), beforeOther);
    return { storage, phase: saved.value, rollbackVerified: true, postEraseSettlementRejected: true, otherRoomPreserved: true };
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

export async function deletionPhaseAcceptance(phase: Phase, outcome: Outcome | null = null) {
  const fixture = await new DeletionServiceFixture().open();
  try {
    await fixture.seedPhase(phase, outcome); const source = await directorySnapshot(fixture.source);
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202);
    await fixture.assertGone(); assert.deepEqual(await directorySnapshot(fixture.source), source);
    await fixture.restart(); await fixture.assertGone();
    return { phase, outcome, deleted: true, sharedSourcePreserved: true };
  } finally { await fixture.close(); }
}
export async function deletionOperationAcceptance(status: string) {
  const fixture = await new DeletionServiceFixture().open();
  try {
    await fixture.seedOperation(status); await fixture.archive(); assert.equal((await fixture.delete()).status, 202);
    const saved = await deletionUntil(() => fixture.service.engine.roomDeletion(fixture.room), saved => ['waiting', 'paused', 'deleted'].includes(saved?.value ?? ''), 'settled deletion preparation');
    if (['uncertain', 'running', 'cancelling'].includes(status)) {
      assert.equal(saved!.value, 'waiting', JSON.stringify(saved)); assert(saved!.context.blockers.length);
      const physical = fixture.service.engine.view(fixture.room, fixture.task)!.context.intents.flatMap(work => work.localOperations ?? []);
      assert(physical.some(op => op.status === 'uncertain'));
      await fixture.reviewUnknown();
    }
    await fixture.assertGone(); return { status, deleted: true, executions: fixture.backend.calls.length };
  } finally { await fixture.close(); }
}

export async function deletionHistoricalRuntimeAcceptance() {
  const fixture = await new DeletionServiceFixture().open('', false);
  try {
    await fixture.seedPhase();
    const engine = fixture.service.engine, work = engine.claim(fixture.room, fixture.task, engine.pending(fixture.room, fixture.task)[0]!.id)!;
    const action: LocalAction = { type: 'runCli', executable: 'node', execution: 'host', reason: '受控的原命令准备及批准',
      args: ['-e', "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/partial.txt','room-A-partial');console.log('known A')"] };
    const namespace = engine.localNamespace(fixture.room, fixture.task);
    const request = engine.requestLocal(fixture.room, fixture.task, work.id, work.attempt, action, [], fixture.runtime.workspaceId(work, namespace));
    const first = engine.claimLocal(fixture.room, fixture.task, work.id, request.id, work.attempt).operation!;
    const prepared = await fixture.runtime.execute(work, first, new AbortController().signal, () => assert.fail('Unapproved command cannot start'), undefined,
      { roomId: fixture.room, taskId: fixture.task });
    assert(prepared.approval);
    assert(fixture.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: first.id, sessionId: first.sessionId!, approval: prepared.approval }).ok);
    assert(engine.decideHostApproval(fixture.room, fixture.task, work.id, first.id, prepared.approval.id, 'approve', randomUUID()).ok);
    const second = engine.claimLocal(fixture.room, fixture.task, work.id, first.id, work.attempt).operation!;
    assert.notEqual(first.sessionId, second.sessionId);
    const completion = await fixture.runtime.execute(work, second, new AbortController().signal, metadata => {
      assert(fixture.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: second.id, sessionId: second.sessionId!, ...metadata }).ok);
    }, undefined, { roomId: fixture.room, taskId: fixture.task });
    assert(completion.result.ok, completion.result.code);
    assert(fixture.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: second.id, sessionId: second.sessionId!, ...completion }).ok);
    assert(fixture.event({ type: 'WAIT_USER', workId: work.id, fence: work, question: '保留部分成果等待处理' }).ok);
    const otherTask = engine.submit(fixture.otherRoom, { id: 'same-message', text: '保留另一会话', goal: { text: '保留另一会话', constraints: [], criteria: [], requiredArtifacts: 0 } }).taskId!;
    const other = engine.claim(fixture.otherRoom, otherTask, engine.pending(fixture.otherRoom, otherTask)[0]!.id)!;
    const otherAction: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "require('fs').writeFileSync('other.txt','room-B');console.log('known B')"] };
    const otherRequest = engine.requestLocal(fixture.otherRoom, otherTask, other.id, other.attempt, otherAction, [],
      fixture.runtime.workspaceId(other, engine.localNamespace(fixture.otherRoom, otherTask)));
    assert.equal(otherRequest.id, second.id, 'Operation IDs may collide across rooms');
    const otherOp = engine.claimLocal(fixture.otherRoom, otherTask, other.id, otherRequest.id, other.attempt).operation!;
    const otherResult = await fixture.runtime.execute(other, otherOp, new AbortController().signal, metadata => {
      assert(fixture.event({ type: 'LOCAL_STARTED', intentId: other.id, operationId: otherOp.id, sessionId: otherOp.sessionId!, ...metadata }, otherTask, fixture.otherRoom).ok);
    }, undefined, { roomId: fixture.otherRoom, taskId: otherTask });
    assert(otherResult.result.ok);
    assert(fixture.event({ type: 'LOCAL_RESULT', intentId: other.id, operationId: otherOp.id, sessionId: otherOp.sessionId!, ...otherResult }, otherTask, fixture.otherRoom).ok);
    assert(fixture.event({ type: 'WAIT_USER', workId: other.id, fence: other, question: '保留另一会话' }, otherTask, fixture.otherRoom).ok);
    const dataRoot = join(fixture.root, 'runtime'), sessionHash = createHash('sha256').update(second.sessionId!).digest('hex');
    await writeFile(join(dataRoot, 'sessions', sessionHash + '.json.pending'), await readFile(join(dataRoot, 'sessions', sessionHash + '.json')));
    const inventory = await fixture.runtime.planRoomCleanup({ roomId: fixture.room, tasks: [engine.view(fixture.room, fixture.task)!], quiescent: true });
    assert.equal(inventory.sessions.length, 2); assert(inventory.complete && inventory.executionsSettled);
    assert(inventory.assets.some(asset => asset.kind === 'journalPending' && asset.identity !== null));
    const otherWorkspace = fixture.runtime.workspaceId(other, engine.localNamespace(fixture.otherRoom, otherTask)).slice('workspace:'.length);
    const otherFiles = await directorySnapshot(otherWorkspace), otherSnapshot = fixture.service.snapshot(fixture.otherRoom);
    const otherHash = createHash('sha256').update(otherOp.sessionId!).digest('hex');
    const protectedJournal = await readFile(join(dataRoot, 'sessions', otherHash + '.json'), 'utf8');
    const source = await directorySnapshot(fixture.source);
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202); await fixture.assertGone();
    assert.deepEqual(await directorySnapshot(otherWorkspace), otherFiles);
    assert.equal(await readFile(join(dataRoot, 'sessions', otherHash + '.json'), 'utf8'), protectedJournal);
    assert.deepEqual(fixture.service.snapshot(fixture.otherRoom).messages, otherSnapshot.messages);
    assert.deepEqual(await directorySnapshot(fixture.source), source);
    assert(await fixture.runtime.verifyRoomCleanup(inventory));
    return { sessions: inventory.sessions.length, assets: inventory.assets.length, collidingOperationId: true, otherRoomUnchanged: true };
  } finally { await fixture.close(); }
}

export async function deletionPathBoundaryAcceptance(boundary: string) {
  const fixture = await new DeletionServiceFixture().open('', false);
  try {
    await fixture.seedOperation('succeeded');
    const inventory = await fixture.runtime.planRoomCleanup({ roomId: fixture.room,
      tasks: [fixture.service.engine.view(fixture.room, fixture.task)!], quiescent: true });
    // Retire only the logical owner after its actual finite command has settled.
    const work = fixture.context().intents.find(work => work.kind === 'owner')!;
    assert(fixture.event({ type: 'SETTLE', intentId: work.id }).ok);
    const clean = await fixture.runtime.planRoomCleanup({ roomId: fixture.room,
      tasks: [fixture.service.engine.view(fixture.room, fixture.task)!], quiescent: true });
    const archived = await fixture.archive(), store = deletionStore(fixture.service.engine.store);
    let saved = fixture.service.engine.requestRoomDeletion(fixture.room, 'boundary-delete', archived.archiveVersion!);
    const step = (event: Record<string, unknown>) => saved = store.stepDeletion(fixture.room,
      { id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!, ...event } as RoomDeletionEvent);
    const prepare = saved.context.intents.find(intent => intent.kind === 'prepare')!;
    step({ type: 'CLAIM', intentId: prepare.id });
    const claimedPrepare = saved.context.intents.find(intent => intent.id === prepare.id)!;
    step({ type: 'PREPARED', intentId: claimedPrepare.id, attempt: claimedPrepare.attempt, inventory: clean });
    const remove = saved.context.intents.find(intent => intent.kind === 'removeAsset' && intent.status === 'pending')!;
    assert(remove); step({ type: 'CLAIM', intentId: remove.id });
    const claim = saved.context.intents.find(intent => intent.id === remove.id)!;
    const asset = structuredClone(saved.context.assets.find(asset => asset.id === claim.assetId)!); assert.equal(asset.kind, 'workspace');
    const outside = join(fixture.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'protected.txt'), 'outside-preserved');
    if (boundary === '路径穿越') asset.path = '../outside';
    if (boundary === '所有权标识不匹配') asset.owner.roomId = fixture.otherRoom;
    if (boundary === '目标为越界符号链接') {
      await rm(join(fixture.root, 'runtime', asset.path), { recursive: true }); await symlink(outside, join(fixture.root, 'runtime', asset.path));
    }
    if (boundary === '父目录被替换为符号链接') {
      await renameFixtureFolder(join(fixture.root, 'runtime', 'workspaces'), join(fixture.root, 'moved-workspaces'));
      await symlink(outside, join(fixture.root, 'runtime', 'workspaces'));
    }
    if (boundary === '领取后目标身份被替换') {
      await rm(join(fixture.root, 'runtime', asset.path), { recursive: true }); await mkdir(join(fixture.root, 'runtime', asset.path));
      await writeFile(join(fixture.root, 'runtime', asset.path, 'replacement.txt'), 'new identity');
    }
    await assert.rejects(fixture.runtime.cleanupRoom({ roomId: fixture.room, deletionId: saved.context.deletionId!, intentId: claim.id, attempt: claim.attempt, asset }, new AbortController().signal));
    assert.equal(await readFile(join(outside, 'protected.txt'), 'utf8'), 'outside-preserved');
    return { boundary, rejected: true, outsidePreserved: true, originalInventoryBlockedUntilRetired: !inventory.executionsSettled };
  } finally { await fixture.close(); }
}
async function renameFixtureFolder(source: string, target: string) { const { rename } = await import('node:fs/promises'); await rename(source, target); }

export async function seedDeletionCopy(fixture: DeletionServiceFixture, halfPrepared = false) {
  await fixture.seedPhase(); const engine = fixture.service.engine;
  const owner = engine.claim(fixture.room, fixture.task, engine.pending(fixture.room, fixture.task)[0]!.id)!;
  assert(fixture.event({ type: 'USER_INPUT', text: '请核查员在副本核查', reviewTargets: ['B'] }).ok);
  const planner = engine.claim(fixture.room, fixture.task, engine.pending(fixture.room, fixture.task).find(work => work.kind === 'facilitator')!.id)!;
  assert(fixture.event({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId,
    decision: { action: 'review', question: '取得可核对的副本资料', expected: '部分结果', reason: '明确邀请' } }).ok);
  const member = engine.claim(fixture.room, fixture.task, engine.pending(fixture.room, fixture.task).find(work => work.kind === 'assistance')!.id)!;
  const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "const fs=require('fs');for(const p of ['dist','test-results','reports','coverage']){fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/partial.txt','real partial result')}console.log('copy receipt')"] };
  const request = engine.requestLocal(fixture.room, fixture.task, member.id, member.attempt, action, [],
    fixture.runtime.workspaceId(member, engine.localNamespace(fixture.room, fixture.task)));
  const op = engine.claimLocal(fixture.room, fixture.task, member.id, request.id, member.attempt).operation!;
  const result = await fixture.runtime.execute(member, op, new AbortController().signal, metadata => {
    assert(fixture.event({ type: 'LOCAL_STARTED', intentId: member.id, operationId: op.id, sessionId: op.sessionId!, ...metadata }).ok);
  }, undefined, { roomId: fixture.room, taskId: fixture.task }); assert(result.result.ok);
  assert(fixture.event({ type: 'LOCAL_RESULT', intentId: member.id, operationId: op.id, sessionId: op.sessionId!, ...result }).ok);
  assert(fixture.event({ type: 'STOP' }).ok);
  for (const work of fixture.context().intents.filter(work => ['inflight', 'uncertain', 'pending'].includes(work.status)
    && !work.localOperations?.some(op => ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status))))
    fixture.event({ type: 'SETTLE', intentId: work.id });
  const key = createHash('sha256').update(`${op.namespace}:${member.id}`).digest('hex');
  if (halfPrepared) await rm(join(fixture.root, 'runtime', 'copies', key + '.json'));
  const session = createHash('sha256').update(op.sessionId!).digest('hex');
  await writeFile(join(fixture.root, 'runtime', 'sessions', session + '.json.pending'), await readFile(join(fixture.root, 'runtime', 'sessions', session + '.json')));
  const inventory = await fixture.runtime.planRoomCleanup({ roomId: fixture.room, tasks: [engine.view(fixture.room, fixture.task)!], quiescent: true });
  assert(inventory.complete && inventory.executionsSettled); return inventory;
}

export async function deletionOwnedFilesAcceptance(resource: string, half = false) {
  const fixture = await new DeletionServiceFixture().open('', false);
  try {
    const inventory = await seedDeletionCopy(fixture, half || resource === '尚无完成元数据的准备副本');
    const mapping: Record<string, string> = { '默认任务工作区': 'workspace', '隔离执行副本': 'copy', '副本完成元数据': 'copyMarker',
      '尚无完成元数据的准备副本': 'copy', '工作区内的.home和.tmp': 'copy', '检查输出和部分完成产物': 'copy',
      '全部历史session的journal': 'journal', 'journal的.json.pending': 'journalPending', '全部历史session的执行日志': 'log' };
    const asset = inventory.assets.find(asset => asset.kind === mapping[resource] && asset.identity !== null); assert(asset, resource);
    if (resource !== '副本完成元数据' || !half) assert.notEqual(asset.identity, null, resource);
    if (resource === '工作区内的.home和.tmp') {
      assert((await lstat(join(fixture.root, 'runtime', asset.path, '.home'))).isDirectory());
      assert((await lstat(join(fixture.root, 'runtime', asset.path, '.tmp'))).isDirectory());
    }
    if (resource === '检查输出和部分完成产物') assert.equal(await readFile(join(fixture.root, 'runtime', asset.path, 'dist', 'partial.txt'), 'utf8'), 'real partial result');
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202); await fixture.assertGone();
    assert(await fixture.runtime.verifyRoomCleanup(inventory));
    return { resource, deleted: true, assets: inventory.assets.length, actualCliExecutions: fixture.backend.calls.length };
  } finally { await fixture.close(); }
}

/** Runtime projection verification is exercised through real copy preparation and owned file cleanup. */
export async function deletionRuntimeProjectionAcceptance() {
  const fixture = await new DeletionServiceFixture().open();
  const target = fixture.room, other = fixture.otherRoom;
  const cleanup = fixture.runtime.cleanupRoom.bind(fixture.runtime);
  try {
    await seedDeletionCopy(fixture);
    fixture.room = other; const otherInventory = await seedDeletionCopy(fixture); fixture.room = target;
    const source = await directorySnapshot(fixture.source);
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202); await fixture.assertGone();
    const firstTombstone = fixture.service.engine.roomDeletion(target)!;

    // Missing-cache-purge fault: perform the same validated physical removals through the owned
    // filesystem layer, while deliberately omitting LocalRuntime's projection retirement.
    const filesOnly = new RuntimeOwnership(join(fixture.root, 'runtime'), fixture.source);
    fixture.runtime.cleanupRoom = (claim, signal) => filesOnly.remove(claim, signal);
    fixture.room = other; fixture.otherRoom = target;
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202);
    const blocked = await deletionUntil(() => fixture.service.engine.roomDeletion(other),
      saved => ['paused', 'deleted'].includes(saved?.value ?? ''), 'independent runtime cache verification');
    assert.equal(blocked!.value, 'paused', 'Files alone cannot prove runtime projection removal, and deleting the first room cannot clear the second room cache');
    assert.equal(blocked!.context.completedAt, null); assert(blocked!.context.dataErased);
    assert(await filesOnly.verify(otherInventory), 'All owned files must actually be gone before asserting the cache-only blocker');
    assert.equal(await fixture.runtime.verifyRoomCleanup(otherInventory), false, 'The surviving prepared-copy promise must prevent clean verification');
    fixture.runtime.cleanupRoom = cleanup;
    // Reconstruct the runtime as an actual host restart would. A deliberately faulty old
    // in-memory projection is not repaired by pretending already-removed files are pending.
    await fixture.restart(true);
    assert(await fixture.runtime.verifyRoomCleanup(otherInventory), 'A newly reconstructed runtime has no stale prepared-copy projection');
    const resumed = fixture.service.engine.roomDeletion(other)!;
    assert.equal(resumed.context.deletionId, blocked!.context.deletionId);
    assert.equal((await fixture.request(fixture.route() + '/delete-retry', { id: 'retry-runtime-cache', deletionId: resumed.context.deletionId,
      expectedDeletionVersion: resumed.context.revision })).status, 202);
    const completed = await deletionUntil(() => fixture.service.engine.roomDeletion(other),
      saved => ['deleted', 'paused', 'waiting'].includes(saved?.value ?? ''), 'projection restart continuation');
    assert.equal(completed!.value, 'deleted', JSON.stringify({ phase: completed!.value, reason: completed!.context.reason,
      blockers: completed!.context.blockers, dataErased: completed!.context.dataErased, remainingRows: fixture.readRows() }));
    assert(await fixture.runtime.verifyRoomCleanup(otherInventory));
    assert.deepEqual(fixture.service.engine.roomDeletion(target), firstTombstone);
    assert.deepEqual(fixture.readRows().rooms, []); assert.deepEqual(fixture.readRows().events, []);
    assert.equal((await fixture.request(fixture.route())).status, 410);
    assert.deepEqual(await directorySnapshot(fixture.source), source);
    return { retainedBeforeReview: true, deleted: true, filesWereGoneBeforeProjection: true,
      independentRoomCachePreserved: true, restoredCleanupCompletedOriginalRequest: true };
  } finally { await fixture.close(); }
}

export async function deletionPhysicalPreparationAcceptance() {
  const fixture = await new DeletionServiceFixture().open('running');
  let release!: () => void;
  try {
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const write = fixture.runtime.journal.write.bind(fixture.runtime.journal);
    fixture.runtime.journal.write = async record => { if (record.phase === 'prepared') { entered = true; await gate; } await write(record); };
    const task = fixture.service.submit(fixture.room, { id: 'pending-preparation', text: '在准备过程中请求删除' }).taskId!; fixture.task = task;
    await deletionUntil(() => entered, Boolean, 'physical preparation entered');
    assert.equal(fixture.runtime.roomQuiescent(fixture.room), false);
    await fixture.archive(); assert.equal((await fixture.delete()).status, 202);
    const waiting = await deletionUntil(() => fixture.service.engine.roomDeletion(fixture.room), saved => saved?.value === 'waiting', 'physical preparation held deletion');
    assert(waiting!.context.blockers.some(blocker => blocker.kind === 'execution'));
    assert.equal(fixture.runtime.roomQuiescent(fixture.room), false);
    release(); await deletionUntil(() => fixture.runtime.roomQuiescent(fixture.room), Boolean, 'actual preparation completion');
    const saved = fixture.service.engine.roomDeletion(fixture.room)!;
    assert.equal((await fixture.request(fixture.route() + '/delete-retry', { id: 'retry-preparation', deletionId: saved.context.deletionId,
      expectedDeletionVersion: saved.context.revision })).status, 202);
    await fixture.assertGone();
    assert.equal(fixture.backend.calls.length, 0, 'Aborted preparation may not launch a process after retirement');
    return { waitedForActualIo: true, deleted: true, processLaunches: 0 };
  } finally { release?.(); await fixture.close(); }
}

if (process.argv[1]?.endsWith('room-deletion-acceptance.ts')) {
  const results: unknown[] = [await deletionStoreAcceptance('Memory'), await deletionStoreAcceptance('SQLite')];
  for (const phase of ['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking', 'stopping', 'ended'] as const)
    results.push(await deletionPhaseAcceptance(phase, phase === 'ended' ? 'partial' : null));
  for (const status of ['queued', 'claimed', 'awaitingApproval', 'running', 'cancelling', 'uncertain', 'succeeded', 'failed', 'cancelled'])
    results.push(await deletionOperationAcceptance(status));
  results.push(await deletionHistoricalRuntimeAcceptance());
  for (const boundary of ['路径穿越', '目标为越界符号链接', '父目录被替换为符号链接', '领取后目标身份被替换', '所有权标识不匹配'])
    results.push(await deletionPathBoundaryAcceptance(boundary));
  console.log(JSON.stringify({ results }, null, 2));
}
