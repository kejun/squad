import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as turn } from 'node:timers/promises';
import { WebService } from '../src/web/service.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { SqliteStore } from '../src/store.js';
import { createTeamConfig } from '../team.config.js';
import type { TeamConfig } from '../src/types.js';
import type { WorkAdapter } from '../src/runner.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import { verifyServiceCompositionModel } from './service-composition-model-gate.js';

interface Probe { entries: { roomId: string; taskId: string; intentId?: string }[]; hostRoom?: string; hostThrown?: boolean; entryBarrier?: Promise<void> }
declare global { var __squadServiceComposition: Probe | undefined }
function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
async function turns() { for (let index = 0; index < 8; index++) await turn(); }
async function until(read: () => boolean, name: string) {
  for (let index = 0; index < 200; index++) { if (read()) return; await turn(); }
  assert.fail('Service barrier not reached: ' + name);
}

/** Real service/SQLite, controlled external promises and actual timer callbacks. */
export class ServiceCompositionFixture {
  root = '';
  private database = '';
  private service: WebService | undefined;
  private runtime?: LocalRuntime;
  private readonly config: TeamConfig = createTeamConfig({});
  private readonly calls: { roomId: string; workId: string; kind: string }[] = [];
  private readonly gate = barrier<void>();
  private readonly entry = barrier<void>();
  private readonly reconciliation = barrier<null>();
  private reconciliationCalls: string[] = [];
  private readonly probe: Probe = { entries: [] };
  private rooms: string[] = [];
  private tasks: string[] = [];
  private closing?: Promise<void>;
  private beforeCloseCalls = 0;
  private report: Record<string, unknown> = {};
  constructor(readonly scenario: string, readonly order = '') {
    this.config.inputAnalysis = { enabled: false };
    this.config.limits.workTimeoutMs = 60_000; this.config.limits.progressIntervalMs = 60_000;
    if (scenario === 'BT_K07') this.config.resilience = { ...this.config.resilience, automaticTimeoutMs: 60_000 };
  }
  private readonly adapter: WorkAdapter = { execute: async (work, _signal, scope) => {
    this.calls.push({ roomId: scope.sessionId!, workId: work.id, kind: work.kind });
    if (this.scenario === 'BT_K05') {
      if (work.kind === 'owner') { await this.gate.promise; return { type: 'deliver', text: '一次完整结果', artifactIds: [] }; }
      return fixtureCheck(work.payload.candidate);
    }
    if (this.scenario === 'BT_K07') return work.kind === 'check' ? fixtureCheck(work.payload.candidate)
      : { type: 'deliver', text: '宿主故障后沿原窗口完成的真实服务结果', artifactIds: [] };
    return { type: 'askUser', question: '等待明确的下一步' };
  } };
  private start(local?: LocalRuntime) { this.service = new WebService(this.config, this.database, this.adapter, undefined, false, local); return this.service; }
  async prepare() {
    this.report.modelGate = verifyServiceCompositionModel();
    this.root = await mkdtemp(join(tmpdir(), 'squad-service-composition-')); this.database = join(this.root, 'team.sqlite');
    globalThis.__squadServiceComposition = this.probe;
    mock.timers.enable({ apis: ['setInterval'] });
    if (this.scenario === 'BT_K03') { await this.prepareStartup(); return; }
    const service = this.start(); await service.ready();
    this.rooms = [service.createRoom('服务组合一').id, service.createRoom('服务组合二').id];
    if (this.scenario === 'BT_K04') return;
    if (this.scenario === 'BT_K05') {
      this.probe.entryBarrier = this.entry.promise;
      this.tasks = [service.submit(this.rooms[0]!, { id: 'same-round', text: '同轮完成一次交付' }).taskId!];
      return;
    }
    if (this.scenario === 'BT_K06') {
      this.probe.entryBarrier = this.entry.promise;
      this.tasks = this.rooms.map((room, index) => service.submit(room, { id: 'storage-' + index, text: '等待存储领取' }).taskId!);
      assert(service.engine.store instanceof SqliteStore); service.engine.store.failNextCommit = true;
      return;
    }
    assert.equal(this.scenario, 'BT_K07');
    this.probe.hostRoom = this.rooms[0]!;
    this.tasks = [service.submit(this.rooms[0]!, { id: 'host-error', text: '宿主调度边界故障' }).taskId!];
    await until(() => service.snapshot(this.rooms[0]!).tasks[0]?.supervision?.status === 'faulted', 'non-storage host error');
    assert(this.probe.hostThrown); assert.equal(this.calls.length, 0, 'Host failure must precede the adapter, not be an adapter WorkFailure');
    const context = service.engine.view(this.rooms[0]!, this.tasks[0]!)!.context;
    assert.equal(context.resilience!.window.openedAt, context.messages[0]!.at);
    assert.equal(context.resilience!.window.hardDeadline, context.messages[0]!.at + 60_000);
    assert(context.trace.some(row => row.event === 'SUPERVISE' && JSON.parse(row.detail).trigger === 'hostFailure'));
    this.report.originalWindow = structuredClone(context.resilience!.window);
  }
  private async prepareStartup() {
    await mkdir(join(this.root, 'source'));
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.root, 'runtime'), workspaceRoot: join(this.root, 'source'), skillRoots: [],
      backend: { available: false, async execute() { assert.fail('Startup fixture must never spawn a command'); } } });
    const seed = this.start(this.runtime); await seed.ready();
    this.rooms = [seed.createRoom('待核对一').id, seed.createRoom('待核对二').id];
    for (const roomId of this.rooms) {
      const taskId = seed.engine.submit(roomId, { id: 'persisted-operation', text: '核对未决操作' }).taskId!;
      const pending = seed.engine.pending(roomId, taskId)[0]!;
      const work = seed.engine.claim(roomId, taskId, pending.id)!;
      assert(work);
      const op = seed.engine.requestLocal(roomId, taskId, work.id, work.attempt, { type: 'runCli', executable: 'node', args: ['-e', '0'] }, [], 'workspace:' + roomId);
      const claimed = seed.engine.claimLocal(roomId, taskId, work.id, op.id, work.attempt);
      assert(claimed.response.ok && claimed.operation?.sessionId);
      assert(seed.engine.send(roomId, taskId, { type: 'LOCAL_STARTED', id: 'started', at: Date.now(), intentId: work.id,
        operationId: op.id, sessionId: claimed.operation.sessionId, workspaceRevision: 'controlled-revision', isolated: false }).ok);
      this.tasks.push(taskId);
    }
    await seed.close(); this.service = undefined;
    this.runtime.reconcile = async op => { this.reconciliationCalls.push(op.id); return this.reconciliation.promise; };
    this.start(this.runtime);
    await until(() => this.reconciliationCalls.length === 1, 'first startup reconciliation');
    this.beforeCloseCalls = this.reconciliationCalls.length;
  }
  async act(order = this.order) {
    if (this.scenario === 'BT_K03') {
      this.closing = this.service!.close(); this.service = undefined;
      this.reconciliation.release(null); await this.closing; return;
    }
    if (this.scenario === 'BT_K04') {
      const service = this.service!;
      this.tasks = [service.submit(this.rooms[0]!, { id: 'registered-before-close', text: '保持已提交消息' }).taskId!];
      this.closing = service.close(); this.service = undefined;
      await this.closing; return;
    }
    const service = this.service!;
    if (this.scenario === 'BT_K05') {
      const events = order.split('、'); assert.deepEqual([...events].sort(), ['定时', '完成', '重复'].sort());
      this.report.eventOrder = events;
      for (const event of events) {
        if (event === '定时') mock.timers.tick(1000);
        if (event === '重复') assert(service.submit(this.rooms[0]!, { id: 'same-round', text: '同轮完成一次交付' }).duplicate);
        if (event === '完成') { this.entry.release(); this.gate.release(); }
      }
      await until(() => service.snapshot(this.rooms[0]!).tasks[0]?.outcome === 'complete', 'deduplicated completion');
      mock.timers.tick(1000); await turns(); return;
    }
    if (this.scenario === 'BT_K06') this.entry.release();
    await turns();
    if (this.scenario === 'BT_K06') {
      mock.timers.tick(1000); await turns();
      const third = service.createRoom('故障后的新群');
      assert.throws(() => service.submit(third.id, { id: 'after-fault', text: '不能取得新许可' }), /Storage fault/, 'InstanceStorageFailStop: every room rejects new permits');
      await turns(); return;
    }
    service.submit(this.rooms[0]!, { id: 'supplement-after-host-error', text: '补充同一目标的核对要求', intent: 'supplement', replyToTaskId: this.tasks[0]! });
    await turns();
    assert.equal(this.calls.filter(call => call.roomId === this.rooms[0]).length, 0,
      'RoomHostFailStop: temporary quarantine must block new external work before the next supervisor callback');
    this.tasks.push(service.submit(this.rooms[1]!, { id: 'other-after-host-error', text: '其他房间仍可运行' }).taskId!);
    await until(() => service.snapshot(this.rooms[1]!).tasks[0]?.outcome === 'complete', 'other room completes while first room is quarantined');
    assert.equal(this.calls.filter(call => call.roomId === this.rooms[0]).length, 0);
    this.report.quarantinedBeforeTick = { first: service.snapshot(this.rooms[0]!), other: service.snapshot(this.rooms[1]!) };
    mock.timers.tick(1000);
    await until(() => service.snapshot(this.rooms[0]!).tasks[0]?.outcome === 'complete', 'same-instance supervisor recovers quarantined room');
    const context = service.engine.view(this.rooms[0]!, this.tasks[0]!)!.context;
    const window = this.report.originalWindow as { id: string; openedAt: number; hardDeadline: number };
    assert.equal(context.resilience!.window.id, window.id); assert.equal(context.resilience!.window.openedAt, window.openedAt);
    assert.equal(context.resilience!.window.hardDeadline, window.hardDeadline, 'Recovery must not silently open a new processing window');
    assert(context.resilience!.window.repairUsed <= context.resilience!.window.repairLimit);
    assert(context.usage.ordinary <= context.config.limits.ordinary && context.usage.retries <= context.config.limits.retries);
    assert(context.trace.some(row => row.event === 'RECOVER'), 'The real Engine.recover path must own resumption');
    assert.equal(context.intents.flatMap(work => work.localOperations ?? []).length, 0, 'This pre-adapter host fault cannot invent or replay physical effects');
    this.report.recoveredWindow = structuredClone(context.resilience!.window);
  }
  assertScope() {
    if (this.scenario === 'BT_K03') {
      assert.equal(this.reconciliationCalls.length, this.beforeCloseCalls, 'CloseDuringStartup: no second external reconciliation may begin after close');
      assert.equal(this.calls.length, 0); this.report.closedBeforeStartup = true;
    } else if (this.scenario === 'BT_K04') {
      assert.equal(this.calls.length, 0, 'CloseBeforeMicrotask: registered work cannot start I/O after close');
      assert.equal(this.probe.entries.length, 0, 'CloseBeforeMicrotask: no registered public runner may start after close');
      const db = new DatabaseSync(this.database, { readOnly: true });
      try { assert.equal(db.prepare('SELECT count(*) AS n FROM receipts WHERE id=?').get('registered-before-close')?.n, 1); }
      finally { db.close(); }
    } else if (this.scenario === 'BT_K05') {
      assert.equal(this.calls.filter(call => call.kind === 'owner').length, 1); assert.equal(this.calls.filter(call => call.kind === 'check').length, 1);
      const counts = new Map<string, number>();
      for (const entry of this.probe.entries) { const key = entry.roomId + ':' + entry.intentId; counts.set(key, (counts.get(key) ?? 0) + 1); }
      assert([...counts.values()].every(count => count === 1), 'PumpDedupe: timer/duplicate/finally must not enter the same public work runner twice');
      assert.deepEqual(this.service!.snapshot(this.rooms[0]!).tasks[0]!.usage, { ordinary: 1, checks: 1 });
    } else if (this.scenario === 'BT_K06') {
      assert.equal(this.calls.length, 0, 'InstanceStorageFailStop: no room may start external I/O after a commit fault');
    } else {
      for (const room of this.rooms) {
        assert.equal(this.calls.filter(call => call.roomId === room && call.kind === 'owner').length, 1, 'Each room must perform its original business work once');
        assert.equal(this.calls.filter(call => call.roomId === room && call.kind === 'check').length, 1);
        assert.equal(this.service!.snapshot(room).tasks[0]!.outcome, 'complete');
      }
    }
    this.report.beforeReopen = { calls: structuredClone(this.calls), runnerEntries: structuredClone(this.probe.entries), reconciliations: [...this.reconciliationCalls], sqlite: this.sqlite() };
  }
  async reopen() {
    await this.service!.close(); this.service = undefined;
    this.calls.length = 0; this.probe.entries.length = 0; delete this.probe.hostRoom;
    const service = this.start(); await service.ready(); await turns();
    if (this.scenario === 'BT_K07') {
      assert.equal(this.calls.length, 0, 'A new instance must not execute already completed room work again');
      for (const room of this.rooms) assert.equal(service.snapshot(room).tasks[0]!.outcome, 'complete');
      assert(service.submit(this.rooms[0]!, { id: 'host-error', text: '宿主调度边界故障' }).duplicate);
      await turns(); assert.equal(this.calls.length, 0, 'The original user command remains idempotent after reopening');
      const original = this.report.originalWindow as { hardDeadline: number };
      assert.equal(service.engine.view(this.rooms[0]!, this.tasks[0]!)!.context.resilience!.window.hardDeadline, original.hardDeadline);
      this.report.reopened = { calls: structuredClone(this.calls), snapshots: this.rooms.map(room => service.snapshot(room)) }; return;
    }
    const expected = this.scenario === 'BT_K06' ? this.rooms : [this.rooms[0]!];
    for (const roomId of expected) assert(this.calls.some(call => call.roomId === roomId), 'SameDatabaseRecovery: a fresh instance must resume persisted eligible work');
    this.report.reopened = { calls: structuredClone(this.calls), snapshots: this.rooms.map(room => service.snapshot(room)) };
  }
  sqlite() {
    const db = new DatabaseSync(this.database, { readOnly: true });
    try { return { rooms: db.prepare('SELECT id,data FROM rooms').all(), receipts: db.prepare('SELECT * FROM receipts').all() }; }
    finally { db.close(); }
  }
  result() { return { scenario: this.scenario, order: this.order, ...this.report }; }
  async close() {
    this.entry.release(); this.gate.release(); this.reconciliation.release(null);
    if (this.service) { await this.service.close(); this.service = undefined; }
    await this.closing; await this.runtime?.close();
    mock.timers.reset(); globalThis.__squadServiceComposition = undefined;
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
