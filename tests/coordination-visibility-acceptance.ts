import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebService } from '../src/web/service.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { SqliteStore } from '../src/store.js';
import { createTeamConfig } from '../team.config.js';
import type { CoordinationView } from '../src/coordination-view.js';
import type { Intent, TaskEvent } from '../src/types.js';
import type { LocalOperation } from '../src/local-operation.js';
import type { WebRoom } from '../src/web/contracts.js';
import { modelResponse } from './model-regeneration-fixture.js';

interface RecordRef { room: WebRoom; taskId: string; work: Intent; operation?: LocalOperation }
interface ModelRequest { messages: { role: string; content: string }[] }
const privateBody = 'PRIVATE_DOCUMENT_BODY_NOT_EXECUTION_METADATA';
const boundaries = ['首次协调', '请求间状态变化', '服务恢复后协调'] as const;

/** Real WebService/SQLite/Runner/adapter; host launch/results are controlled
 * event receipts, without a native-process or sandbox claim. */
export class CoordinationVisibilityAcceptance {
  directory!: string;
  database!: string;
  service!: WebService;
  readonly config = createTeamConfig({});
  readonly requests: ModelRequest[] = [];
  readonly records = new Map<string, RecordRef>();
  coordinateRoom!: WebRoom;
  addedRoom?: WebRoom;
  boundary: typeof boundaries[number] = '首次协调';
  private sequence = 0;
  result?: Record<string, unknown>;

  async open() {
    this.directory = await mkdtemp(join(tmpdir(), 'squad-coordination-view-')); this.database = join(this.directory, 'team.sqlite');
    this.config.inputAnalysis = { enabled: false }; this.config.webTools = { enabled: false }; this.config.skillSearch = { enabled: false };
    this.config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 30_000, cancelGraceMs: 1 };
    this.config.models = { default: 'fixture', services: { fixture: { baseUrl: 'https://model.example/v1', model: 'coordination-fixture' } } };
    await this.start();
    const source = this.record('未决旧会话'); this.operation(source, 'held-workspace', false); this.started(source);
    this.event(source, { type: 'LOCAL_RESULT', intentId: source.work.id, operationId: source.operation!.id,
      sessionId: source.operation!.sessionId!, result: { ok: false, code: 'EFFECT_UNKNOWN', data: { stdout: privateBody } }, settled: true, effectsKnown: false });
    this.event(source, { type: 'STOP' }); this.event(source, { type: 'SUPERVISE', trigger: 'timer' });
    this.service.setRoomArchived(source.room.id, randomUUID(), true);
    const active = this.record('实际启动会话'); this.operation(active, 'active-workspace', false); this.started(active);
    const queued = this.record('排队会话'); this.operation(queued, 'held-workspace', true);
    const approval = this.record('待授权会话'); this.operation(approval, 'approval-workspace', false, true);
    this.event(approval, { type: 'LOCAL_APPROVAL_REQUIRED', intentId: approval.work.id, operationId: approval.operation!.id,
      sessionId: approval.operation!.sessionId!, fence: approval.work,
      approval: { id: 'coordination-approval', digest: 'd'.repeat(64), status: 'pending', expiresAt: Date.now() + 30_000,
        plan: { executable: '/usr/bin/node', args: ['--help'], cwd: '/task', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64),
          environmentHash: 'e'.repeat(64), host: 'fixture-host', account: 'fixture-account', reason: '需要精确批准' } } });
    const ended = this.record('已结束会话'); this.event(ended, { type: 'EXHAUSTED', reason: '保留已有结束事实' });
    this.coordinateRoom = this.service.createRoom('当前协调会话'); this.service.createRoom('无任务会话');
    const registry = new SqliteStore(this.database);
    try { registry.transact(this.coordinateRoom.id, tx => { assert(tx.acquireResources!([{ key: 'unmapped-resource', mode: 'write', phase: 'execute' }], 'unmapped-owner')); }); }
    finally { registry.close(); }
    this.assertReadonly(); return this;
  }

  private async start() {
    const adapter = new OpenAICompatibleAdapter(this.config, { transport: async (_url, init) => {
      this.requests.push(JSON.parse(String(init?.body)) as ModelRequest);
      if (this.boundary === '请求间状态变化' && this.requests.length === 1) {
        const active = this.records.get('实际启动会话')!;
        this.event(active, { type: 'LOCAL_RESULT', intentId: active.work.id, operationId: active.operation!.id,
          sessionId: active.operation!.sessionId!, result: { ok: true, code: 'succeeded', data: { stdout: privateBody } }, settled: true, effectsKnown: true });
        this.addedRoom = this.service.createRoom('两次请求之间新增会话'); return modelResponse('{');
      }
      return modelResponse({ type: 'decision', decision: { action: 'continue', reason: '观察不获得额外执行许可' } });
    } });
    this.service = new WebService(this.config, this.database, {
      execute: (work, signal, scope) => work.kind === 'facilitator' ? adapter.execute(work, signal, scope)
        : Promise.resolve({ type: 'askUser', question: '仅保留当前任务，不改变其他执行' }),
    });
    await this.service.ready();
  }

  private event(record: RecordRef, body: Record<string, unknown>) {
    const reply = this.service.engine.send(record.room.id, record.taskId,
      { id: `coordination-observation:${++this.sequence}`, at: Date.now(), ...body } as TaskEvent);
    assert(reply.ok, JSON.stringify(reply)); return reply;
  }
  private record(title: string): RecordRef {
    const room = this.service.createRoom(title), submitted = this.service.engine.submit(room.id, { id: randomUUID(), text: '验证执行元数据',
      goal: { text: '验证执行元数据', constraints: [], criteria: [], requiredArtifacts: 0 } });
    assert(submitted.ok && submitted.taskId);
    const pending = this.service.engine.pending(room.id, submitted.taskId).find(work => work.kind === 'owner')!; assert(pending);
    const work = this.service.engine.claim(room.id, submitted.taskId, pending.id)!; assert(work);
    const record = { room, taskId: submitted.taskId, work }; this.records.set(title, record); return record;
  }
  private operation(record: RecordRef, workspaceId: string, blocked: boolean, host = false) {
    const action = { type: 'runCli' as const, executable: 'node', args: ['--help'], ...(host ? { execution: 'host' as const, reason: '需要精确批准' } : {}) };
    const requested = this.service.engine.requestLocal(record.room.id, record.taskId, record.work.id, record.work.attempt, action, [], workspaceId);
    const claimed = this.service.engine.claimLocal(record.room.id, record.taskId, record.work.id, requested.id, record.work.attempt);
    assert.equal(claimed.response.ok, !blocked, JSON.stringify(claimed.response));
    if (blocked) assert.equal(claimed.response.code, 'WORKSPACE_BUSY'); record.operation = claimed.operation!;
  }
  private started(record: RecordRef) { this.event(record, { type: 'LOCAL_STARTED', intentId: record.work.id, operationId: record.operation!.id, sessionId: record.operation!.sessionId! }); }
  private state() {
    const db = new DatabaseSync(this.database, { readOnly: true });
    try { return JSON.stringify({ rooms: db.prepare('SELECT id,data FROM rooms ORDER BY id').all(),
      leases: db.prepare('SELECT key,owner FROM workspace_leases ORDER BY key,owner').all(),
      resources: db.prepare('SELECT key,owner,mode,phase FROM resource_leases ORDER BY key,owner,phase').all(),
      receipts: db.prepare('SELECT room_id,id,result FROM receipts ORDER BY room_id,id').all() }); }
    finally { db.close(); }
  }
  private assertReadonly() {
    assert.equal(typeof this.service.coordinationSnapshot, 'function', 'The host must provide a complete global coordinator observation');
    const before = this.state(), first = this.service.coordinationSnapshot(); this.service.coordinationSnapshot();
    assert.equal(this.state(), before, 'Observing twice must not approve, settle, charge or change task state');
    const count = first.rooms.length; first.rooms.pop();
    assert.equal(this.service.coordinationSnapshot().rooms.length, count, 'A model-facing view cannot mutate the authoritative room collection');
  }
  async exercise(boundary: string) {
    assert(boundaries.includes(boundary as typeof boundaries[number])); this.boundary = boundary as typeof boundaries[number];
    if (boundary === '服务恢复后协调') { await this.service.close(); await this.start(); this.assertReadonly(); }
    const submitted = this.service.engine.submit(this.coordinateRoom.id, { id: randomUUID(), text: '根据全部执行状态协调当前工作',
      goal: { text: '协调当前工作', constraints: [], criteria: [], requiredArtifacts: 0 } });
    assert(submitted.ok && submitted.taskId);
    const owner = this.service.engine.claim(this.coordinateRoom.id, submitted.taskId, this.service.engine.pending(this.coordinateRoom.id, submitted.taskId)[0]!.id)!;
    this.event({ room: this.coordinateRoom, taskId: submitted.taskId, work: owner },
      { type: 'BLOCKED', workId: owner.id, fence: owner, reason: '需要读取全局执行状态再协调' });
    const expected = boundary === '请求间状态变化' ? 2 : 1, until = Date.now() + 5000;
    while (this.requests.length < expected && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(this.requests.length, expected, 'A real facilitator request and its bounded format repair must execute');
  }
  private view(index: number): CoordinationView {
    const messages = this.requests[index]!.messages.map(message => { try { return JSON.parse(message.content) as Record<string, unknown>; } catch { return null; } });
    const observed = messages.find(message => message?.type === 'coordination_view');
    assert(observed, 'The actual facilitator HTTP input must include the complete global execution observation');
    assert.equal(observed.readOnly, true); return observed as unknown as CoordinationView;
  }
  verifyGlobal() {
    const view = this.view(0); assert.equal(view.complete, true); assert.equal(view.rooms.length, 7);
    const source = this.records.get('未决旧会话')!, queued = this.records.get('排队会话')!, active = this.records.get('实际启动会话')!, approval = this.records.get('待授权会话')!;
    const task = (record: RecordRef) => view.rooms.find(room => room.id === record.room.id)!.tasks.find(task => task.id === record.taskId)!;
    const operation = (record: RecordRef) => task(record).works.flatMap(work => work.operations).find(op => op.id === record.operation!.id)!;
    assert.equal(view.rooms.find(room => room.id === source.room.id)!.archived, true);
    assert.equal(operation(source).status, 'uncertain'); assert.equal(operation(source).actuallyStarted, true);
    assert.equal(operation(queued).status, this.boundary === '服务恢复后协调' ? 'cancelled' : 'queued');
    assert.equal(operation(queued).actuallyStarted, false); assert.equal(operation(queued).approval, undefined);
    assert.equal(operation(active).actuallyStarted, true);
    assert.equal(operation(approval).status, 'awaitingApproval'); assert.equal(operation(approval).approval?.status, 'pending'); assert.equal(operation(approval).actuallyStarted, false);
    assert(task(source).gates.some(gate => gate.scope === 'cleanup' && gate.status === 'open'));
    assert(task(source).cleanup.some(item => item.operationId === source.operation!.id && item.state === 'pending'));
    assert.equal(task(this.records.get('已结束会话')!).phase, 'ended');
    for (const record of this.records.values()) {
      for (const bot of this.config.bots) assert(task(record).members.some(member => member.id === bot.id));
      assert.equal(task(record).window.hardDeadline, this.service.engine.view(record.room.id, record.taskId)!.context.resilience!.window.hardDeadline);
    }
    assert(view.leases.some(lease => lease.owner === 'unmapped-owner' && lease.holder === null), 'Unknown holders must not be silently omitted');
    assert(view.leases.some(lease => lease.holder?.operationId === source.operation!.id));
    if (this.boundary !== '服务恢复后协调') {
      const wait = view.waits.find(wait => wait.operationId === queued.operation!.id)!; assert(wait);
      assert(wait.blocking.some(blocker => blocker.holder?.roomId === source.room.id && blocker.holder.operationId === source.operation!.id));
      assert.equal(task(queued).supervision.decision, 'resources'); assert(!task(queued).supervision.effectiveWorkIds.includes(queued.work.id));
    }
    assert(!JSON.stringify(view).includes(privateBody), 'Execution observation must not copy source document or stdout bodies');
    if (this.boundary === '请求间状态变化') {
      const next = this.view(1), nextActive = next.rooms.find(room => room.id === active.room.id)!.tasks.find(task => task.id === active.taskId)!;
      assert.equal(operation(active).status, 'running'); assert.equal(nextActive.works.flatMap(work => work.operations).find(op => op.id === active.operation!.id)!.status, 'succeeded');
      assert(!view.rooms.some(room => room.id === this.addedRoom!.id)); assert(next.rooms.some(room => room.id === this.addedRoom!.id));
    }
    this.result = { boundary: this.boundary, visibleRooms: view.rooms.length, modelRequests: this.requests.length, fullGlobalObservation: true };
  }
  verifyReadonly() {
    this.assertReadonly(); const source = this.records.get('未决旧会话')!, approval = this.records.get('待授权会话')!;
    assert.equal(this.service.engine.view(source.room.id, source.taskId)!.context.intents.flatMap(work => work.localOperations ?? []).find(op => op.id === source.operation!.id)!.status, 'uncertain');
    assert.notEqual(this.service.engine.view(approval.room.id, approval.taskId)!.context.intents.flatMap(work => work.localOperations ?? []).find(op => op.id === approval.operation!.id)!.approval!.status, 'approved');
  }
  async close() { await this.service?.close(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
}
export async function coordinationVisibilityAcceptance(boundary = '首次协调') {
  const fixture = new CoordinationVisibilityAcceptance();
  try { await fixture.open(); await fixture.exercise(boundary); fixture.verifyGlobal(); fixture.verifyReadonly(); return fixture.result; }
  finally { await fixture.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await coordinationVisibilityAcceptance(process.argv[2]), null, 2));
