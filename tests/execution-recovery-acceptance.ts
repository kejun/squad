import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { LocalRuntime } from '../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkFailure, WorkRunner, type WorkScope } from '../src/runner.js';
import { WebService } from '../src/web/service.js';
import { MemoryStore, type Transaction } from '../src/store.js';
import { ControlledProcessBackend, LocalFixture } from './local-tools-fixture.js';
import { Harness } from './helpers.js';
import { regenerationConfig } from './model-regeneration-fixture.js';
import { hostUntil } from './host-approval-fixture.js';
import { inventoryObservation } from './tool-inventory-observation.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import { DatabaseSync } from 'node:sqlite';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { persistTask } from '../src/task.machine.js';
import { taskStorageVersion } from '../src/task/protocol.js';
import { executionRecoverySeed, type RecoveryRole } from './execution-recovery-model-fixture.js';
import { currentReceiptWork, documentFive, documentUrl, receiptModel, receiptSemantics, recordCliObservation } from './execution-receipts-model-fixture.js';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import { operationAcquisitionSnapshot, savedResourceAcquisitions } from '../src/resource-acquisition.js';

/** Production service/SQLite/Runner/native provider HTTP and real Node subprocess; no OS-isolation claim. */
export async function webScopeRecoveryAcceptance(role: string) {
  const root = await mkdtemp(join(tmpdir(), 'squad-scope-recovery-'));
  const backend = new ControlledProcessBackend();
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const discover = { type: 'discoverHost', commands: ['node'] };
  const help = { type: 'help' as const, target: 'B', requestId: 'preflight', question: 'document read', expected: '真实工具发现记录' };
  const answer = { type: 'answer', text: '已核实读取入口', status: 'success' };
  const fallback = [{ type: 'web_fetch', url: 'https://source.fixture.example/doc' },
    { type: 'runCli', executable: 'node', args: ['-e', 'console.log("document fallback evidence")'] },
    role === '系统协调员' ? { type: 'decision', decision: { action: 'askUser', question: '完成本轮验证', reason: '替代读取成功' } }
      : { type: 'answer', text: '替代读取完成并保留失败来源', status: 'success' }];
  const replies = role === '负责人' ? [discover, answer, ...fallback]
    : [discover, role === '协助成员' ? help : { type: 'blocked', reason: 'document read需要换方法' }, ...fallback];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    assert(replies.length, 'Controlled provider responses exhausted');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies.shift()) } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const config = regenerationConfig({ workTimeoutMs: 10_000 });
  config.inputAnalysis = { enabled: false };
  config.models!.services.test!.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), skillRoots: [], backend,
    cliCatalog: [{ command: 'node', description: 'document read', helpArgs: ['--help'] }] });
  const adapter = new OpenAICompatibleAdapter(config);
  let owners = 0, targetDone = false, webCalls = 0, targetId = '', usageBefore = 0, usageAfter = 0;
  let targetScope: WorkScope | undefined;
  const service = new WebService(config, join(root, 'team.sqlite'), { execute: async (work, signal, scope) => {
    if (work.kind === 'check') return fixtureCheck(work.payload.candidate);
    if (work.kind === 'owner') {
      owners++;
      if (role === '负责人' && owners === 1) return help;
      if (role === '协助成员' && owners > 1) return { type: 'askUser', question: '完成本轮验证' };
    }
    const target = role === '负责人' ? work.kind === 'owner' && owners > 1
      : role === '协助成员' ? work.kind === 'assistance' : work.kind === 'facilitator';
    if (target) {
      targetScope = scope; targetId = work.id;
      usageBefore = service.engine.view(roomId, taskId)!.context.usage.ordinary;
    }
    try { return await adapter.execute(work, signal, scope); }
    finally {
      if (target) { usageAfter = service.engine.view(roomId, taskId)!.context.usage.ordinary; targetDone = true; }
    }
  } }, { search: async () => { throw new Error('Unexpected search'); }, fetch: async () => {
    webCalls++; throw new WorkFailure('web_fetch_unsupported_resource');
  } }, false, runtime);
  let roomId = '', taskId = '';
  try {
    await service.ready(); roomId = service.createRoom('Adapter scope recovery').id;
    taskId = service.submit(roomId, { id: 'source', text: 'document read' }).taskId!;
    await hostUntil(() => targetDone, Boolean); await wait(0);
    assert(targetScope);
    assert.equal(typeof targetScope.recordToolFailure, 'function');
    // The wrapper must retain live getters, not a snapshot which becomes stale after the CLI.
    const targetRequests = requests.slice(2);
    assert.equal(targetRequests.length, 3);
    assert(targetRequests.every(request => request.messages.some(message => message.content.includes('"type":"tool_inventory"'))));
    assert(targetRequests[0]!.messages.some(message => message.content.includes('"type":"shared_tool_knowledge"')));
    const work = service.engine.view(roomId, taskId)!.context.intents.find(item => item.id === targetId)!;
    assert.equal(work.toolRecovery?.failures.length, 1);
    assert.equal(work.toolRecovery.failures[0]!.code, 'WEB_TOOL_UNSUPPORTED_RESOURCE');
    assert.equal(work.localOperations?.filter(op => op.action.type === 'runCli').length, 1);
    assert.equal(backend.calls.length, 1); assert.equal(webCalls, 1);
    assert.equal(usageAfter - usageBefore, 4, 'Only Web, two follow-up models and one CLI add ordinary usage');
    assert.equal(work.status, 'done');
    assert.equal(replies.length, 0);
    return { role, modelRequests: requests.length, webCalls, cliCalls: backend.calls.length,
      failureCount: work.toolRecovery.failures.length, additionalOrdinary: usageAfter - usageBefore };
  } finally {
    await service.close(); await runtime.close(); provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

export async function configurationDiagnosticAcceptance(label: string) {
  const f = await LocalFixture.create('方案师', true);
  try {
    f.h.room = 'configuration-diagnostics';
    f.h.task = f.h.engine.submit(f.h.room, { id: 'read', text: 'document read',
      goal: { text: 'document read', constraints: [], criteria: ['报告真实执行状态'], requiredArtifacts: 0 } }).taskId!;
    const { cliCatalog: _catalog, ...options } = f.runtime.options;
    await f.runtime.close();
    const command = label === '已核实相关命令未安装' ? 'squad-no-installed-reader' : 'node';
    const entry = { command, description: label === '已配置目录但无相同词项' ? 'unrelated backup' : 'document read',
      helpArgs: label === '已核实相关账号需要认证' ? ['-e', 'console.error("authentication required");process.exit(1)'] : ['--help'],
      ...(label === '已核实宿主授权被拒绝' ? { execution: 'host' as const } : {}) };
    f.runtime = await LocalRuntime.create({ ...options, commandEnv: { ...options.commandEnv, node: { PRIVATE_TOKEN: 'sensitive-tool-configuration' } },
      redact: [...(options.redact ?? []), 'sensitive-tool-configuration'], ...(label === '自动发现CLI目录为空' ? {
        cliDiscovery: { paths: [join(f.root, 'empty-path')], manRoots: [], systemPackageRoot: join(f.root, 'no-packages') } }
      : { cliCatalog: label === '已配置空CLI目录' ? [] : [entry] }) });
    if (label === '已核实相关命令未安装') f.replies.push({ type: 'discoverHost', commands: [command] });
    if (label === '已核实相关账号需要认证') f.replies.push({ type: 'runCli', executable: 'node',
      args: ['-e', 'console.error("authentication required");process.exit(1)'] });
    if (label === '已核实宿主授权被拒绝') f.replies.push({ type: 'runCli', executable: 'node', args: ['--help'], execution: 'host', reason: '需要核实宿主读取入口' });
    f.replies.push({ type: 'answer', text: '已报告配置及已知前提，不虚构正文取得。' });
    const running = f.runner().runOne(f.h.room, f.h.task);
    if (label === '已核实宿主授权被拒绝') {
      const operation = await hostUntil(() => f.h.context().intents.flatMap(work => work.localOperations ?? [])
        .find(op => op.status === 'awaitingApproval'), value => !!value);
      assert(operation);
      const work = f.h.context().intents.find(item => item.localOperations?.some(op => op.id === operation.id))!;
      assert(f.h.engine.decideHostApproval(f.h.room, f.h.task, work.id, operation.id, operation.approval!.id, 'deny', 'direct-user-denial').ok);
      f.runtime.notifyWorkspace(`approval:${operation.id}`);
    }
    await running;
    const request = f.requests.at(-1)!;
    const inventory = inventoryObservation(request);
    const state = label === '自动发现CLI目录为空' || label === '已配置空CLI目录' ? 'empty' : 'configured';
    if (label === '自动发现CLI目录为空') assert.equal(inventory.cli.configuration.source, 'automatic');
    assert.equal(inventory.cli.configuration.state, state);
    assert.equal(inventory.cli.entries.length, state === 'configured' ? 1 : 0);
    const chosen = inventory.cli.entries[0];
    const readiness = chosen?.variants.find(variant => variant.execution === (chosen.execution ?? 'sandbox'))?.readiness;
    if (label === '已核实相关命令未安装') assert.equal(readiness?.installation, 'not_found');
    if (label === '已核实宿主授权被拒绝') assert.equal(readiness?.authorization, 'denied');
    if (label === '已核实相关账号需要认证') assert.equal(readiness?.authentication, 'required');
    if (label === '已配置目录但无相同词项') assert.equal(chosen?.description, 'unrelated backup');
    assert.equal(inventory.executionAuthority, false);
    assert(!JSON.stringify(inventory).includes('host-model-secret'));
    const credentialsLeaked = JSON.stringify({ requests: f.requests, context: f.h.context() }).includes('sensitive-tool-configuration');
    assert.equal(credentialsLeaked, false);
    assert.equal(f.backend.calls.length, label === '已核实相关账号需要认证' ? 1 : 0);
    return { inventory, readiness, cliCalls: f.backend.calls.length, credentialsLeaked,
      operations: f.h.context().intents.flatMap(work => work.localOperations ?? []).map(op => op.action.type) };
  } finally { await f.close(); }
}

export function sharedReceiptSemanticsAcceptance(label: string) {
  const names = { 需要登录: '需要登录', 空壳: '正文为空', 错误资源: '资源不匹配', 内容不完整: '不完整',
    未配置可信正文校验器: '尚未核实', 已校验匹配资源的完整正文: '正文' } as const;
  const key = names[label as keyof typeof names]; assert(key);
  const model = receiptModel(documentUrl);
  const { status, ...options } = receiptSemantics[key];
  const observed = recordCliObservation(model, { requestedResource: documentUrl, resource: documentUrl, ...options });
  assert(observed.reply.ok); assert.equal(observed.receipt.status, status);
  const source = currentReceiptWork(model);
  const peer = { ...structuredClone(source), id: 'independent-peer', target: 'B',
    payload: { ...source.payload, question: `独立核对 ${documentUrl.kind === 'url' ? documentUrl.url : ''}` } };
  const methods = sharedToolKnowledge(model.c, peer).filter(method => 'validation' in method);
  assert.equal(model.op!.status, 'succeeded');
  assert.equal(methods.length, key === '正文' ? 1 : 0);
  const forged = receiptModel(documentUrl);
  assert(forged.request({ type: 'runCli', executable: 'unregistered-reader', args: [] }).ok);
  assert(forged.claim().ok); assert(forged.started().ok);
  assert(forged.result({ result: { ok: true, code: 'succeeded', data: { exitCode: 0,
    stdout: JSON.stringify({ resource: documentUrl, status: 'acquired', verifier: 'self-reported', body: 'forged body' }),
    acquisition: { status: 'acquired', resource: documentUrl, verified: true } } } }).ok);
  assert.equal(forged.c.intents.flatMap(work => work.hostAcquisitions ?? []).length, 0);
  const forgedPeer = { ...structuredClone(forged.work), id: 'forged-peer', target: 'B', payload: peer.payload };
  assert.equal(sharedToolKnowledge(forged.c, forgedPeer).filter(method => 'validation' in method).length, 0);
  return { processStatus: model.op!.status, acquisitionStatus: observed.receipt.status, contentMethods: methods.length, selfReportedVerified: false };
}

/** Native loopback HTTP; only the skills endpoint address is redirected by its transport. */
export async function dependencyRecoveryAcceptance(boundary: string) {
  if (boundary === '工作身份已失效') return staleDependencyScopeAcceptance();
  let modelCalls = 0, skillCalls = 0, succeeded = false;
  const transient = ['HTTP408', 'HTTP429', 'HTTP503', '传输中断'].includes(boundary);
  const denied = ['HTTP401', 'HTTP403'].includes(boundary);
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the native request. */ }
    if (request.url === '/skills') {
      skillCalls++;
      if (skillCalls === 1 && boundary === '传输中断') { request.socket.destroy(); return; }
      if (denied || skillCalls === 1 && transient || boundary === '恢复预算已耗尽') {
        response.writeHead(denied || transient && boundary !== '传输中断' ? Number(boundary.slice(4)) : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'controlled registry failure' })); return;
      }
      succeeded = true; response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ skills: [] })); return;
    }
    modelCalls++;
    response.writeHead(200, { 'content-type': 'application/json' });
    const output = succeeded ? { type: 'answer', text: '技能依赖恢复后给出可信结果。' } : { type: 'findSkills', query: 'document reader' };
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const config = regenerationConfig({ retries: boundary === '恢复预算已耗尽' ? 0 : 2,
    ordinary: boundary === '恢复预算已耗尽' ? 2 : 20, workTimeoutMs: 1000 });
  config.inputAnalysis = { enabled: false };
  if (boundary === '功能权限关闭') config.skillSearch = { enabled: false };
  config.models!.services.test!.baseUrl = base + '/v1';
  const h = new Harness(config);
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now });
  const runner = new WorkRunner(h.engine, adapter, () => h.now, async (_url, init) => fetch(base + '/skills', init));
  try {
    if (boundary === '任务已停止') assert(h.event({ type: 'STOP' }).ok);
    if (boundary === '任务自动处理期限已到') {
      h.now = h.context().resilience!.window.hardDeadline;
      assert(h.event({ type: 'SUPERVISE', trigger: 'timer' }).ok);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await runner.runOne(h.room, h.task))) break;
      if (h.context().candidate || h.view().phase === 'waitingHuman' || h.context().outcome !== null) break;
    }
    if (transient) {
      assert.equal(skillCalls, 2);
      assert.equal(modelCalls, 3);
      assert(h.context().candidate?.text.includes('依赖恢复'));
      assert.equal(h.context().usage.retries, 1);
      assert.equal(h.context().usage.ordinary, 5);
    } else {
      assert.equal(skillCalls, denied || boundary === '恢复预算已耗尽' ? 1 : 0);
      assert(h.context().outcome !== null || h.view().phase === 'waitingHuman' && !!h.context().reason.trim(),
        'A denied or exhausted dependency needs an explicit gate or a real degraded outcome');
    }
    assert(!JSON.stringify(h.context()).includes('controlled registry failure'));
    return { modelCalls, skillCalls, phase: h.view().phase, outcome: h.context().outcome,
      reason: h.context().reason, usage: structuredClone(h.context().usage) };
  } finally {
    runner.detachExecutions();
    h.store.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function staleDependencyScopeAcceptance() {
  const h = new Harness(regenerationConfig());
  let entered!: () => void, release!: () => void, skillCalls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sourceId = '';
  const runner = new WorkRunner(h.engine, { execute: async (work, _signal, scope) => {
    sourceId = work.id; entered(); await gate; await scope.findSkills('document reader');
    return { type: 'answer', text: 'Stale source cannot publish' };
  } }, () => h.now, async () => { skillCalls++; return Response.json({ skills: [] }); });
  try {
    const executing = runner.runOne(h.room, h.task); await ready;
    assert(h.event({ type: 'USER_INPUT', text: '更新任务目标', goal: { text: '新任务目标', constraints: [], criteria: ['新目标'], requiredArtifacts: 0 } }).ok);
    release(); await executing;
    assert.equal(skillCalls, 0);
    assert.equal(h.context().candidate, null);
    assert.notEqual(h.context().intents.find(work => work.id === sourceId)!.status, 'pending');
    return { modelCalls: 0, skillCalls, phase: h.view().phase, outcome: h.context().outcome,
      reason: '陈旧工作未授权外部技能请求', usage: structuredClone(h.context().usage) };
  } finally { release(); runner.detachExecutions(); h.store.close(); }
}

class RetiredStore extends MemoryStore {
  retired = false; lateAccesses = 0;
  override read(roomId: string) { if (this.retired) { this.lateAccesses++; throw new Error('Retired store read'); } return super.read(roomId); }
  override transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    if (this.retired) { this.lateAccesses++; throw new Error('Retired store write'); } return super.transact(roomId, fn);
  }
  override close() { this.retired = true; }
}

export async function cancellationDrainAcceptance(callback: string) {
  const store = new RetiredStore();
  const h = new Harness(regenerationConfig(), store);
  let started!: () => void, release!: () => void, fail!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancellation = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const runner = new WorkRunner(h.engine, { execute: async (_work, signal) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, cancel: async () => cancellation }, () => h.now);
  const running = runner.runOne(h.room, h.task); await ready;
  assert(h.event({ type: 'STOP' }).ok);
  const cancelling = runner.runOne(h.room, h.task);
  await running;
  assert.equal(h.context().outcome, 'stopped');
  const drain = await runner.drainExecutions(5);
  assert.equal(drain.settled, false); assert.equal(drain.pending, 1);
  const usage = structuredClone(h.context().usage);
  runner.detachExecutions(); store.close();
  await cancelling;
  if (callback === '在宽限后返回') release();
  if (callback === '在宽限后失败') fail(new Error('Controlled late cancellation failure'));
  await wait(0);
  assert.equal(store.lateAccesses, 0);
  assert.equal(await runner.runOne(h.room, h.task), false);
  assert.equal(store.lateAccesses, 0);
  return { outcome: 'stopped', drain, lateAccesses: store.lateAccesses, usage };
}

export async function notStartedRunnerAcceptance(role: RecoveryRole, lateBy: number) {
  const snapshot = executionRecoverySeed(role), context = snapshot.context;
  const kind = { 输入解析: 'interpretation', 负责人: 'owner', 协助成员: 'assistance', 系统协调员: 'facilitator',
    交付检查: 'check', 讨论汇总: 'discussionSummary', 分片成员: 'assistance' }[role];
  const work = context.intents.find(item => item.kind === kind && item.status === 'pending')!;
  assert(work && work.deadline !== null);
  const ticks = [work.deadline! - 1, work.deadline! + lateBy];
  let at = ticks[0]!;
  const store = new MemoryStore();
  store.transact('runner-not-started', tx => {
    tx.room.activeTaskId = context.taskId;
    tx.room.tasks[context.taskId] = { version: taskStorageVersion(context.config), snapshot: persistTask(snapshot) };
  });
  const engine = new TeamEngine(store, context.config, () => { at = ticks.shift() ?? at; return at; });
  let adapterCalls = 0;
  const runner = new WorkRunner(engine, { execute: async () => { adapterCalls++; throw new Error('Unstarted adapter must not run'); } }, () => at);
  try {
    assert(await runner.runOne('runner-not-started', context.taskId, work.id));
    for (let index = 0; index < 3; index++) { at++; engine.tick('runner-not-started'); engine.recover('runner-not-started'); }
    const view = engine.view('runner-not-started', context.taskId)!;
    assert.equal(adapterCalls, 0);
    assert(view.context.trace.some(entry => entry.event === 'EXECUTION_NOT_STARTED_CONFIRMED'));
    assert(view.context.outcome !== null || engine.pending('runner-not-started', context.taskId).length > 0
      || view.phase === 'waitingHuman' && !!view.context.reason.trim());
    return { adapterCalls, phase: view.phase, outcome: view.context.outcome, pending: engine.pending('runner-not-started', context.taskId).length };
  } finally { runner.detachExecutions(); store.close(); }
}

/** Close follows every task's responsibility, including a restored non-active approval checkpoint. */
export async function serviceCloseResponsibilitiesAcceptance(label: string) {
  const root = await mkdtemp(join(tmpdir(), 'squad-close-responsibilities-'));
  const database = join(root, 'team.sqlite');
  const config = regenerationConfig({ workTimeoutMs: 10_000 });
  config.inputAnalysis = { enabled: false }; config.resilience = { cancelGraceMs: 10 };
  const callbacks: (() => void)[] = [];
  let calls = 0;
  const runtime = label === '非当前任务的宿主授权等待' ? await LocalRuntime.create({ dataRoot: join(root, 'runtime'), skillRoots: [],
    backend: { available: false, execute: async () => { throw new Error('Host approval must not execute CLI'); } } }) : undefined;
  const adapter = { execute: async (_work: unknown, signal: AbortSignal, scope: WorkScope) => {
    calls++;
    if (runtime && calls === 1) {
      await scope.localTools!.invoke({ type: 'runCli', executable: 'node', args: ['--version'], execution: 'host', reason: '请求读取宿主版本' }, [], signal);
      return { type: 'askUser' as const, question: '批准检查点已处理' };
    }
    return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, cancel: async () => new Promise<void>(resolve => { callbacks.push(resolve); }) };
  let service = new WebService(config, database, adapter, undefined, false, runtime);
  const unhandled: string[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(String(error)); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await service.ready(); const room = service.createRoom('Closing all task histories').id;
    const original = service.submit(room, { id: 'original', text: '记录未完成责任' }).taskId!;
    await hostUntil(() => calls, value => value === 1);
    if (runtime) {
      await hostUntil(() => service.engine.view(room, original)!.context.intents.some(work => work.localOperations?.some(op => op.status === 'awaitingApproval')), Boolean);
      // A legacy task pointer may no longer name the original durable approval waiter.
      assert(service.engine.store instanceof SqliteStore);
      service.engine.store.transact(room, tx => { tx.room.activeTaskId = null; });
      service.submit(room, { id: 'new-active', text: '处理新的活动任务' });
      await hostUntil(() => calls, value => value === 2);
    }
    if (label === '先前停止但尚未结算的任务') {
      service.stop(room, original, 'stop-original');
      await hostUntil(() => service.engine.view(room, original)!.context.outcome === 'stopped', Boolean);
      service.submit(room, { id: 'new-active', text: '新的活动任务' });
      await hostUntil(() => calls, value => value === 2);
    }
    if (label === '已归档房间中的未决任务') service.setRoomArchived(room, 'archive-before-close', true);
    const beforeCloseCalls = calls;
    const start = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([service.close(), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Close exceeded its bounded grace')), 900);
    })]); } finally { if (timeout) clearTimeout(timeout); }
    const durationMs = performance.now() - start;
    assert(durationMs < 900);
    const db = new DatabaseSync(database, { readOnly: true });
    let state: { tasks: Record<string, { snapshot: { context: { outcome: string | null; intents: { localOperations?: { status: string }[] }[] } } }> };
    try { state = JSON.parse((db.prepare('SELECT data FROM rooms WHERE id=?').get(room) as { data: string }).data); }
    finally { db.close(); }
    const saved = state.tasks[original]!.snapshot.context;
    if (runtime) assert(saved.intents.some(work => work.localOperations?.some(op => op.status === 'awaitingApproval')));
    else assert.equal(saved.outcome, 'stopped');
    callbacks.forEach(resolve => resolve()); await wait(0);
    assert.deepEqual(unhandled, []);
    service = new WebService(config, database, adapter, undefined, false, runtime); await service.ready(); await wait(0);
    assert.equal(calls, beforeCloseCalls, 'Restart must not repeat a settled task or execute an approval waiter');
    const after = service.snapshot(room);
    assert.equal(after.room.archived, label === '已归档房间中的未决任务');
    return { durationMs, originalOutcome: saved.outcome, calls, responsibilities: Object.keys(state.tasks).length, unhandled };
  } finally {
    callbacks.forEach(resolve => resolve()); await service.close(); await runtime?.close();
    process.removeListener('unhandledRejection', onUnhandled); await rm(root, { recursive: true, force: true });
  }
}

/** A controlled host cut after real LOCAL_RESULT, before its derived observation commits. */
export async function receiptWindowRecoveryAcceptance(backend: string) {
  assert(['MemoryStore', 'SqliteStore'].includes(backend));
  const root = await mkdtemp(join(tmpdir(), 'squad-receipt-window-'));
  const processBackend = new ControlledProcessBackend();
  const path = join(root, 'state.sqlite');
  let store = backend === 'SqliteStore' ? new SqliteStore(path) : new MemoryStore();
  const config = regenerationConfig({ workTimeoutMs: 10000 }); config.inputAnalysis = { enabled: false };
  const h = new Harness(config, store, 100);
  assert(h.event({ type: 'USER_INPUT', text: '读取文档five并保留真实来源', goal: { text: '读取文档five正文', constraints: [],
    criteria: ['保留真实正文依据'], requiredArtifacts: 0, resourceRequirements: [{ resource: documentFive, freshness: 'saved' }] } }).ok);
  const body = '真实原生命令已取得的文档five正文';
  const action = { type: 'runCli' as const, executable: 'node', args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'five', body }))})`] };
  const runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), skillRoots: [], backend: processBackend, clock: () => h.now,
    acquisitionReaders: [{ id: 'trusted-fixture-json-reader', version: '1', command: 'node', argsPrefix: ['-e'],
      format: 'json-document', resource: documentFive }] });
  let firstRunner: WorkRunner | undefined;
  try {
    // The next event is lost at the host cut. The committed native result remains intact.
    h.engine.recordAcquisition = () => ({ ok: true, code: 'CONTROLLED_HOST_CUT', detail: 'Observer event is lost at the controlled host boundary' });
    let localReturned!: () => void;
    const localComplete = new Promise<void>(resolve => { localReturned = resolve; });
    firstRunner = new WorkRunner(h.engine, { execute: async (_work, signal, scope) => {
      assert(scope.localTools); await scope.localTools.invoke(action, [], signal); localReturned();
      return new Promise<never>(() => {});
    } }, () => h.now, undefined, undefined, runtime);
    const originalRun = firstRunner.runOne(h.room, h.task);
    await Promise.race([localComplete, originalRun.then(() => { throw new Error(`Original fixture execution stopped: ${h.context().reason}`); }),
      wait(2000).then(() => { throw new Error('Native receipt did not settle before controlled cut'); })]);
    const original = h.context().intents.find(work => work.status === 'inflight' && work.kind === 'owner')!;
    const originalOperation = original.localOperations![0]!;
    assert.equal(originalOperation.status, 'succeeded'); assert.equal(processBackend.calls.length, 1);
    assert.equal(original.hostAcquisitions?.length ?? 0, 0, 'The host cut must leave no acquisition event');
    const snapshot = operationAcquisitionSnapshot(originalOperation), usage = structuredClone(h.context().usage);
    firstRunner.detachExecutions(); await originalRun;
    if (backend === 'SqliteStore') { store.close(); store = new SqliteStore(path); }
    let now = 110;
    const engine = new TeamEngine(store, config, () => now); engine.recover(h.room);
    const pending = engine.view(h.room, h.task)!.context.intents.find(work => work.id === original.id)!;
    assert.equal(pending.status, 'pending');
    const observation = runtime.observeAcquisitions(pending, pending.localOperations![0]!, { id: 'task-protocol',
      version: JSON.stringify([config.version, config.toolVersion]), authentication: 'unknown' })[0]!;
    assert(observation);
    assert.equal(engine.recordAcquisition(h.room, h.task, observation).code, 'ACQUISITION_WORK_UNAVAILABLE',
      'Before a legal reclaim the host cannot attach an observation; this temporary refusal must not cache its ID');
    let beforeAdapter = false, observedReceiptCount = -1;
    const recovered = new WorkRunner(engine, { execute: async work => {
      if (work.kind === 'check') return fixtureCheck(work.payload.candidate);
      const current = engine.view(h.room, h.task)!.context;
      const receipts = savedResourceAcquisitions(current);
      observedReceiptCount = receipts.length;
      assert.equal(receipts.length, 1, 'Recovered host observation must exist before the first new adapter call');
      const receipt = receipts[0]!;
      assert.equal(receipt.id, observation.id, 'Reclaim must be able to commit the same observation ID after its temporary refusal');
      assert.equal(receipt.content, body); assert.equal(receipt.operationId, originalOperation.id);
      assert.equal(receipt.attempt, originalOperation.parentAttempt); assert.equal(work.attempt, original.attempt + 1);
      assert.equal(receipt.at, originalOperation.finishedAt); assert.equal(receipt.sourceSnapshot, snapshot);
      assert.equal(current.trace.filter(entry => entry.event === 'RECORD_ACQUISITION').at(-1)!.at, now);
      assert.equal(current.lastActivityAt, now, 'Recording original capture time must not rewind current activity');
      beforeAdapter = true;
      return { type: 'deliver', text: body, artifactIds: [], artifacts: [{ name: 'recovered-document.md', content: body }] };
    } }, () => now, undefined, undefined, runtime);
    assert(await recovered.runOne(h.room, h.task, original.id));
    const current = engine.view(h.room, h.task)!.context;
    assert.equal(observedReceiptCount, 1, 'Recovered host observation must exist before the first new adapter call');
    assert(beforeAdapter); assert.equal(processBackend.calls.length, 1, 'Backfill must never rerun the settled command');
    assert.equal(current.usage.ordinary, usage.ordinary + 1, 'Only the normal recovery claim is charged');
    assert.equal(current.usage.checks, usage.checks); assert.equal(current.usage.retries, usage.retries);
    assert.equal(current.intents.find(work => work.id === original.id)!.requestCount, original.requestCount);
    assert.equal(engine.view(h.room, h.task)!.phase, 'checking');
    assert(await recovered.runOne(h.room, h.task));
    assert.equal(engine.view(h.room, h.task)!.context.outcome, 'complete', 'The recovered acquisition must remain usable through independent delivery verification');
    assert.equal(processBackend.calls.length, 1);
    return { backend, beforeAdapter, commandExecutions: processBackend.calls.length, originalAttempt: originalOperation.parentAttempt,
      restoredAttempt: original.attempt + 1, preservedCaptureTime: true, preservedSnapshot: true, extraAcquisitionCharges: 0, outcome: 'complete' };
  } finally { firstRunner?.detachExecutions(); store.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
}
