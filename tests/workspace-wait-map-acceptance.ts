import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTeamConfig } from '../team.config.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { unconfinedEffectsKey } from '../src/local-resource-policy.js';
import { CloudflareWebTools } from '../src/web-tools.js';
import { WebService } from '../src/web/service.js';
import { effectiveWork, processingWindow, supervisionDecision, taskHumanGate } from '../src/task/resilience.js';
import { savedAcquisitions } from '../src/resource-acquisition.js';
import type { InputIntentSpec, Intent, TaskEvent } from '../src/types.js';
import type { WorkAdapter, WorkOutput, WorkScope } from '../src/runner.js';
import type { LocalOperation } from '../src/local-operation.js';
import type { RoomSnapshot, WebRoom } from '../src/web/contracts.js';

const documentUrls = Array.from({ length: 8 }, (_, index) => `https://www.yuque.com/fixture/october-${index + 1}`);
const loginBody = '<title>Login</title><input type="password">欢迎登录语雀；请登录后查看文档。';
const mapSpec = (): InputIntentSpec => ({ action: 'request', objective: '阅读八份语雀文档，整理十月团队工作',
  constraints: ['必须取得文档正文，保留八篇各自来源，不能用登录欢迎页当作正文'], expectedOutputs: ['十月团队工作汇总'],
  acceptanceCriteria: ['八份正文各覆盖一次；无法读取的明确报告'], references: [], confidence: 1, clarification: null,
  decomposition: { kind: 'mapReduce', synthesis: '归并八份独立正文并保留来源与缺失',
    partitions: documentUrls.map((url, index) => ({ id: `october-${index + 1}`, objective: `独立读取${url}的正文`, expectedOutput: '原文事实和来源' })) } });

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until<T>(read: () => T, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = read(); if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Eight-document resource-wait fixture timed out: ${label}`);
}
type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;
interface OldEffect { room: WebRoom; taskId: string; work: Intent; operation: LocalOperation }

/** Real SDK/HTTP, task model, map queue, runner and SQLite; external model decisions and old effects are controlled.
 * The two old compatible read leases model independently retained unknown effects, not simultaneous host writers.
 * No user account, private document, real provider or native sandbox is used. */
export class WorkspaceWaitMapAcceptance {
  directory = ''; runtime!: LocalRuntime; service!: WebService; pages!: Server; room!: WebRoom; taskId = '';
  readonly old: OldEffect[] = [];
  readonly modelCalls: { kind: Intent['kind']; id: string; partition?: string }[] = [];
  readonly reads: string[] = [];
  readonly cliRequests: string[] = [];
  readonly pageRequests: string[] = [];
  readonly fourthFailure = barrier();
  readonly cliFallback = barrier();
  hostRuntimeEntries = 0; sequence = 0;
  supervisionSummary: unknown;
  private closed = false;

  event(roomId: string, taskId: string, body: Body, at = Date.now()) {
    const reply = this.service.engine.send(roomId, taskId, { ...body, id: `eight-doc:${++this.sequence}`, at } as TaskEvent);
    assert(reply.ok, `${body.type}: ${reply.code}`); return reply;
  }
  context() { return this.service.engine.view(this.room.id, this.taskId)!.context; }
  snapshot(): RoomSnapshot { return this.service.snapshot(this.room.id); }
  queue() { return this.context().discussion!.mapReduce!.queue!; }
  waitingOperations() {
    return this.context().intents.flatMap(work => (work.localOperations ?? []).map(operation => ({ work, operation })))
      .filter(({ operation }) => operation.action.type === 'runCli' && operation.action.execution === 'host');
  }

  async open() {
    this.directory = await mkdtemp(join(tmpdir(), 'squad-eight-doc-wait-'));
    const source = join(this.directory, 'source'); await mkdir(source);
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.directory, 'runtime'), workspaceRoot: source, skillRoots: [],
      backend: { available: true, isolation: 'workspace', async execute() { throw new Error('No unapproved process may reach this backend'); } } });
    const execute = this.runtime.execute.bind(this.runtime);
    this.runtime.execute = (...args) => { this.hostRuntimeEntries++; return execute(...args); };
    this.pages = createServer((request, response) => {
      this.pageRequests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); response.end(loginBody);
    });
    await new Promise<void>(resolve => this.pages.listen(0, '127.0.0.1', resolve));
    const address = this.pages.address(); assert(address && typeof address !== 'string');
    const web = new CloudflareWebTools({ env: {}, transport: (url, init) => {
      const original = new URL(String(url)); assert(documentUrls.includes(original.href));
      return fetch(`http://127.0.0.1:${address.port}${original.pathname}`, init);
    } });
    const config = createTeamConfig({});
    config.models = { default: 'controlled', services: { controlled: { baseUrl: 'https://model.example.test/v1', model: 'controlled' } } };
    config.resilience = { automaticTimeoutMs: 900000, repairTimeoutMs: 30000, repairLimit: 2, cancelGraceMs: 5000 };
    const adapter: WorkAdapter = { execute: (work, signal, scope) => this.execute(work, signal, scope) };
    this.service = new WebService(config, join(this.directory, 'team.sqlite'), adapter, web, false, this.runtime);
    await this.service.ready();
    this.seedOldEffect('旧任务甲'); this.seedOldEffect('旧任务乙');
    this.room = this.service.createRoom('八篇语雀文档的十月汇总');
    const reply = this.service.submit(this.room.id, { id: randomUUID(),
      text: `请分别阅读以下八篇语雀文档，整理十月团队工作，必须取得正文并保留每篇来源：${documentUrls.join(' ')}`,
      goal: { text: `阅读并汇总${documentUrls.join(' ')}`, constraints: ['不能用登录页面代替正文'], criteria: ['八份正文各覆盖一次'], requiredArtifacts: 0,
        resourceRequirements: documentUrls.map(url => ({ resource: { kind: 'url' as const, url }, freshness: 'saved' as const })) } });
    assert(reply.ok, reply.code); this.taskId = reply.taskId!;
    await until(() => this.reads.length, count => count === 4, 'first four login observations');
    assert.equal(this.queue().length, 8);
    assert.equal(this.queue().filter(part => part.status === 'running').length, 4);
    assert.deepEqual(this.reads, documentUrls.slice(0, 4));
    assert.equal(this.cliRequests.length, 0);
  }

  private seedOldEffect(title: string) {
    const room = this.service.createRoom(title), engine = this.service.engine;
    const submitted = engine.submit(room.id, { id: randomUUID(), text: '保留旧读取的实际效果' });
    assert(submitted.ok); const taskId = submitted.taskId!;
    let pending = engine.pending(room.id, taskId)[0]!;
    if (pending.kind === 'interpretation') {
      const work = engine.claim(room.id, taskId, pending.id)!;
      this.event(room.id, taskId, { type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work });
      this.event(room.id, taskId, { type: 'INTERPRETATION_RESULT', workId: work.id, attempt: work.attempt, fence: work,
        inputId: (work.payload.input as { id: string }).id,
        spec: { action: 'request', objective: '保留旧读取的实际效果', constraints: [], expectedOutputs: [], acceptanceCriteria: [], references: [], confidence: 1, clarification: null } });
      pending = engine.pending(room.id, taskId)[0]!;
    }
    const work = engine.claim(room.id, taskId, pending.id)!; assert(work);
    const operation = engine.requestLocal(room.id, taskId, work.id, work.attempt,
      { type: 'runCli', executable: process.execPath, args: ['--help'] }, [], 'old-shared-source', {
        conflictKey: 'old-shared-source', resourceLeases: [
          { key: 'old-shared-source', mode: 'read', phase: 'execute' },
          { key: unconfinedEffectsKey, mode: 'read', phase: 'execute' },
        ],
      });
    const claim = engine.claimLocal(room.id, taskId, work.id, operation.id, work.attempt); assert(claim.response.ok);
    this.event(room.id, taskId, { type: 'LOCAL_STARTED', intentId: work.id, operationId: operation.id, sessionId: claim.operation!.sessionId!, isolated: true });
    this.event(room.id, taskId, { type: 'LOCAL_RESULT', intentId: work.id, operationId: operation.id, sessionId: claim.operation!.sessionId!,
      result: { ok: false, code: 'CONTROLLED_UNKNOWN_EFFECT', data: {} }, settled: true, effectsKnown: false });
    this.event(room.id, taskId, { type: 'STOP' });
    const saved = engine.view(room.id, taskId)!.context.intents.find(item => item.id === work.id)!.localOperations![0]!;
    assert.equal(saved.status, 'uncertain'); this.old.push({ room, taskId, work, operation: saved });
  }

  private async execute(work: Intent, signal: AbortSignal, scope: WorkScope): Promise<WorkOutput> {
    const partition = work.payload.partition as { id: string; objective: string } | undefined;
    this.modelCalls.push({ kind: work.kind, id: work.id, ...(partition ? { partition: partition.id } : {}) });
    if (work.kind === 'interpretation') return { type: 'interpretation', spec: mapSpec() };
    assert.equal(work.kind, 'assistance', 'No repair, synthesis or owner work may replace the blocked map work');
    assert(partition); const url = /https?:\/\/\S+/.exec(partition.objective)![0]!.replace(/的正文$/, '');
    const page = await scope.webFetch({ url }, signal);
    assert.equal(page.hostEvidence?.status, 'authentication_required');
    this.reads.push(url);
    if (partition.id === 'october-4') {
      await this.fourthFailure.promise; signal.throwIfAborted();
      return { type: 'answer', status: 'failed', text: '第四篇只取得登录欢迎页，无法读取正文；不声称正文已取得。' };
    }
    await this.cliFallback.promise; signal.throwIfAborted();
    this.cliRequests.push(partition.id); assert(scope.localTools);
    await scope.localTools.invoke({ type: 'runCli', executable: 'yuque', args: ['--help'], execution: 'host',
      reason: '网页返回登录页，需读取服务账号已登录的语雀CLI帮助' }, [], signal);
    throw new Error('The blocked host command unexpectedly returned');
  }

  async readLoginPagesAndAdvanceFifth() {
    this.fourthFailure.release();
    await until(() => this.reads.length, count => count === 5, 'fourth failure advances the fifth document');
    assert.equal(this.queue().find(part => part.partitionId === 'october-4')!.status, 'failed');
    assert.equal(this.queue().find(part => part.partitionId === 'october-5')!.status, 'running');
    assert.deepEqual(savedAcquisitions(this.context()).map(receipt => receipt.status),
      ['authentication_required', 'authentication_required', 'authentication_required', 'authentication_required', 'authentication_required']);
    assert.equal(this.cliRequests.length, 0);
  }

  async blockAllFourFallbacks() {
    this.cliFallback.release();
    await until(() => this.waitingOperations(), operations => operations.length === 4
      && operations.every(({ operation }) => operation.status === 'queued' && operation.workspaceWait !== undefined), 'four real CLI requests waiting on resource claims');
    assert.deepEqual([...this.cliRequests].sort(), ['october-1', 'october-2', 'october-3', 'october-5']);
  }

  assertPromptBeforeDeadline() {
    const snapshot = this.snapshot(), task = snapshot.tasks.find(task => task.id === this.taskId)!;
    assert(Date.now() < processingWindow(this.context()).hardDeadline);
    assert.equal(task.supervision?.status, 'waitingResources', 'All four queued commands must be visible as resource waiting before the fifteen-minute deadline');
    const blockers = snapshot.blockers?.filter(blocker => blocker.source) ?? [];
    assert.equal(blockers.length, 2, 'The current room must expose both actual old effect owners');
    assert.deepEqual(blockers.map(blocker => blocker.source!.roomId).sort(), this.old.map(effect => effect.room.id).sort());
    for (const effect of this.old) {
      const blocker = blockers.find(blocker => blocker.source!.roomId === effect.room.id)!;
      assert.equal(blocker.taskId, effect.taskId); assert.equal(blocker.operation?.workId, effect.work.id);
      assert.equal(blocker.operation?.operationId, effect.operation.id); assert.equal(blocker.scope, 'cleanup');
    }
  }

  assertNoFalseExecutionOrSource() {
    assert.equal(this.waitingOperations().length, 4);
    assert(this.waitingOperations().every(({ operation }) => operation.status === 'queued' && operation.startedAt === undefined
      && operation.sessionId === undefined && operation.approval === undefined));
    assert.equal(this.snapshot().hostApprovals?.length ?? 0, 0, 'Queued host commands have not yet produced approval requests');
    assert.equal(this.hostRuntimeEntries, 0, 'No blocked command may enter runtime preparation or execution'); assert.equal(this.pageRequests.length, 5);
    assert.equal(savedAcquisitions(this.context()).filter(receipt => receipt.status === 'acquired').length, 0);
    const view = this.service.engine.view(this.room.id, this.taskId)!;
    assert.deepEqual(effectiveWork(view.context, view.phase, Date.now()), []);
    assert.equal(supervisionDecision(view.context, view.phase, Date.now()), 'resources');
    assert.equal(this.queue().filter(part => part.status === 'queued').length, 3);
  }

  assertSupervisionKeepsVisibleWait() {
    const before = this.context(), calls = this.modelCalls.length, usage = structuredClone(before.usage), window = structuredClone(processingWindow(before));
    const assignments = before.discussion!.mapReduce!.assignments.map(assignment => assignment.workId);
    this.event(this.room.id, this.taskId, { type: 'SUPERVISE', trigger: 'timer' }, window.openedAt + 60000);
    this.event(this.room.id, this.taskId, { type: 'SUPERVISE', trigger: 'timer' }, window.openedAt + 120000);
    this.event(this.room.id, this.taskId, { type: 'SUPERVISE', trigger: 'timer' }, window.openedAt + 600000);
    this.assertPromptBeforeDeadline(); this.assertNoFalseExecutionOrSource();
    assert.equal(this.modelCalls.length, calls); assert.equal(this.reads.length, 5);
    assert.deepEqual(this.context().usage, usage);
    assert.deepEqual(this.context().discussion!.mapReduce!.assignments.map(assignment => assignment.workId), assignments);
    assert.deepEqual(processingWindow(this.context()), window);
    this.event(this.room.id, this.taskId, { type: 'SUPERVISE', trigger: 'timer' }, window.hardDeadline + 1);
    assert.equal(this.context().outcome, null);
    assert.equal(this.service.engine.view(this.room.id, this.taskId)!.phase, 'waitingHuman');
    assert.equal(taskHumanGate(this.context())?.cause, 'windowExpired');
    assert.deepEqual(processingWindow(this.context()).failure, { code: 'WINDOW_EXPIRED', at: window.hardDeadline + 1 });
    assert.equal(this.context().resilience!.frozen, undefined);
    assert.equal(this.snapshot().blockers?.filter(blocker => blocker.source).length, 2, 'Window expiry must retain the original unresolved effect review entries');
    assert.equal(this.hostRuntimeEntries, 0); assert.equal(this.modelCalls.length, calls);
    this.supervisionSummary = { partitions: 8, concurrency: 4, webLoginObservations: 5, failedPartition: 'october-4',
      waitingPartitions: ['october-1', 'october-2', 'october-3', 'october-5'], notStartedPartitions: 3,
      oldUnresolvedEffects: 2, classificationBeforeDeadline: 'resources', currentRoomPromptBeforeDeadline: true,
      falseApprovals: 0, hostRuntimeEntries: this.hostRuntimeEntries, cliSessions: this.waitingOperations().filter(({ operation }) => operation.sessionId).length,
      extraModelCallsDuringSupervision: 0, outcomeAtOriginalDeadline: this.context().outcome,
      sourceBoundary: 'Real local HTTP/SDK/Runner/Engine/SQLite; controlled model and old-effects prefix; no private docs or real provider' };
  }

  assertExpiredResourceRecovery() {
    const context = this.context();
    assert.equal(context.outcome, null);
    assert.equal(taskHumanGate(context)?.cause, 'windowExpired');
    const blockers = this.snapshot().blockers?.filter(blocker => blocker.source) ?? [];
    assert.deepEqual(blockers.map(blocker => blocker.source!.roomId).sort(), this.old.map(effect => effect.room.id).sort());
    for (const effect of this.old) {
      const blocker = blockers.find(blocker => blocker.source!.roomId === effect.room.id)!;
      assert.equal(blocker.taskId, effect.taskId); assert.equal(blocker.operation?.workId, effect.work.id);
      assert.equal(blocker.operation?.operationId, effect.operation.id); assert.equal(blocker.scope, 'cleanup');
      const source = this.service.engine.view(effect.room.id, effect.taskId)!.context;
      assert.equal(source.intents.find(work => work.id === effect.work.id)!.localOperations!.find(op => op.id === effect.operation.id)!.status, 'uncertain');
    }
    assert.equal(this.hostRuntimeEntries, 0);
    assert.equal(this.snapshot().hostApprovals?.length ?? 0, 0);
  }

  async close() {
    if (this.closed) return; this.closed = true;
    this.fourthFailure.release(); this.cliFallback.release();
    await this.service?.close(); await this.runtime?.close();
    if (this.pages?.listening) { this.pages.closeAllConnections(); await new Promise<void>(resolve => this.pages.close(() => resolve())); }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

export async function workspaceWaitMapAcceptance() {
  const fixture = new WorkspaceWaitMapAcceptance();
  try {
    await fixture.open(); await fixture.readLoginPagesAndAdvanceFifth(); await fixture.blockAllFourFallbacks();
    fixture.assertPromptBeforeDeadline(); fixture.assertNoFalseExecutionOrSource(); fixture.assertSupervisionKeepsVisibleWait();
    return fixture.supervisionSummary;
  } finally { await fixture.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await workspaceWaitMapAcceptance(), null, 2));
