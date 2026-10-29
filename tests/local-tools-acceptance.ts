import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SkillRegistry } from '../src/local-skills.js';
import { TeamEngine } from '../src/engine.js';
import { MemoryStore, SqliteStore } from '../src/store.js';
import { WorkRunner } from '../src/runner.js';
import { WebService } from '../src/web/service.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { minimalCliEnvironment, sandboxPolicy, SandboxCliBackend } from '../src/local-cli.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { LocalFixture, assertFlow, localConfig, removeFixture, writeSkill } from './local-tools-fixture.js';
import { configuration, Harness } from './helpers.js';
import { modelResponse } from './model-regeneration-fixture.js';
import type { LocalAction, LocalOperation } from '../src/local-operation.js';
import type { Intent } from '../src/types.js';

export async function registryAcceptance() {
  const root = await mkdtemp(join(tmpdir(), 'squad-skill-bdd-'));
  try {
    const skills = join(root, 'skills'); await mkdir(skills); const original = await writeSkill(skills);
    await symlink(original, join(skills, 'alias')); await mkdir(join(skills, 'broken')); await writeFile(join(skills, 'broken', 'SKILL.md'), '---\nname: [\n---');
    const registry = await SkillRegistry.discover({ roots: [skills], snapshotRoot: join(root, 'snapshots') });
    assert.equal(registry.list().skills.length, 1); assert.equal(registry.diagnostics.length, 1);
    const loaded = await registry.load(registry.list().skills[0]!.skillId);
    assert((await registry.read(loaded.skillId, 'references/guide.md', loaded.skillVersion)).content.includes('真实引用'));
    await writeFile(join(original, 'references/guide.md'), 'new content');
    assert((await registry.read(loaded.skillId, 'references/guide.md', loaded.skillVersion)).content.includes('真实引用'));
    await assert.rejects(readFile(join(root, 'runs.txt'))); // discovery and activation did not launch the script
    const restarted = await SkillRegistry.discover({ roots: [skills], snapshotRoot: join(root, 'snapshots') });
    assert.notEqual(restarted.catalogVersion, registry.catalogVersion);
    assert((await restarted.read(loaded.skillId, 'references/guide.md', loaded.skillVersion)).content.includes('真实引用'));
  } finally { await removeFixture(root); }
}
export function guardAcceptance(constraint: string, expected?: string) {
  const m = new LocalModel(i => {
    if (constraint === '普通额度耗尽') i.config.limits.ordinary = 1;
    if (constraint === '权限关闭') i.config.localTools = { enabled: false };
    if (['评审汇总保留', '后台讨论保留'].includes(constraint)) i.config.limits.ordinary = 2;
  });
  if (constraint === '已停止') m.send({ type: 'STOP' });
  if (constraint === '工作过期') m.at = 1001;
  if (constraint === '旧目标版本') m.c.goalVersion++;
  if (constraint === '解析阶段') m.c.intents[0]!.kind = 'interpretation';
  if (constraint === '旧任务缺少授权') delete (m.c.intents[0]!.payload.capabilities as Record<string, unknown>).localTools;
  if (constraint === '评审汇总保留') m.c.review = { id: 'r', request: 'review', targets: ['B'], completed: [], status: 'reviewing', epoch: 1, goalVersion: 1 };
  if (constraint === '后台讨论保留') m.c.discussion = { id: 'd', request: 'discuss', targets: ['B'], results: [], skipped: [], status: 'collecting', epoch: 1, goalVersion: 1 };
  const requested = m.request(); const result = requested.ok ? m.claim(constraint !== '租约不可用') : requested;
  if (expected) assert.equal(result.code, expected);
  assert.equal(result.ok, false); assert.equal(m.c.usage.ordinary, 1); assert.equal(m.op?.sessionId, undefined);
  if (m.op?.status === 'queued') {
    assert(m.send({ type: 'LOCAL_REJECTED', intentId: m.work.id, operationId: m.op.id, parentAttempt: m.op.parentAttempt, result: { ok: false, code: result.code, data: {} } }).ok);
    assert.equal(m.op.status, 'failed'); assert.equal(m.op.result?.code, result.code);
  }
  return result.code;
}
export function stopAcceptance(stage: string) {
  const m = new LocalModel(); m.request(); if (stage !== 'queued') m.claim(); if (stage === 'running') m.started();
  m.send({ type: 'STOP' });
  if (stage !== 'queued') {
    assert.equal(m.op?.status, 'cancelling'); assert.equal(m.send({ type: 'SETTLE', intentId: m.work.id }).code, 'LOCAL_OPERATION_PENDING');
    assert.equal(m.c.intents[0]!.status, 'inflight'); assert.equal(m.result({ sessionId: 'wrong' }).ok, false);
    m.result({ result: { ok: false, code: 'cancelled', data: {} } });
  }
  m.send({ type: 'SETTLE', intentId: m.work.id }); assert.equal(m.c.candidate, null); assert.equal(m.c.outcome, 'stopped');
}
export function leaseAcceptance(sqlitePath?: string) {
  const store = sqlitePath ? new SqliteStore(sqlitePath) : new MemoryStore(); const config = configuration();
  const engine = new TeamEngine(store, config, () => 0);
  try {
    const prepared = ['one', 'two', 'three'].map((room, index) => {
      const taskId = engine.submit(room, { id: room, text: '运行受控命令' }).taskId!;
      const work = engine.claim(room, taskId, engine.pending(room, taskId)[0]!.id)!;
      const op = engine.requestLocal(room, taskId, work.id, work.attempt, { type: 'runCli', executable: 'node', args: [] }, [], index < 2 ? 'shared-project' : 'independent-project');
      return { room, taskId, work, op };
    });
    const claim = (index: number) => { const p = prepared[index]!; return engine.claimLocal(p.room, p.taskId, p.work.id, p.op.id, p.work.attempt); };
    const first = claim(0); assert(first.response.ok); assert.equal(claim(1).response.code, 'WORKSPACE_BUSY'); assert(claim(2).response.ok);
    // A duplicate denied claim must NOT release an existing physical workspace lease.
    assert.equal(claim(0).response.code, 'LOCAL_NOT_QUEUED'); assert.equal(claim(1).response.code, 'WORKSPACE_BUSY');
    const p = prepared[0]!;
    const reply = engine.send(p.room, p.taskId, { type: 'LOCAL_RESULT', id: 'result', at: 1, intentId: p.work.id, operationId: p.op.id, sessionId: first.operation!.sessionId!,
      result: { ok: true, code: 'succeeded', data: {} }, settled: true, effectsKnown: true }); assert(reply.ok);
    assert(claim(1).response.ok);
  } finally { store.close(); }
}
export async function skillErrorAcceptance(problem: string, expected: string) {
  const root = await mkdtemp(join(tmpdir(), 'squad-skill-error-'));
  try {
    const skills = join(root, 'skills'), source = await writeSkill(skills); const snapshots = join(root, 'snapshots');
    if (problem === '缺失目录') { const registry = await SkillRegistry.discover({ roots: [join(root, 'missing')], snapshotRoot: snapshots }); assert.equal(registry.list().skills.length, 0); return; }
    const roots = [skills]; if (problem === '同名冲突') { const other = join(root, 'other'); await writeSkill(other); roots.push(other); }
    if (problem === '内部链接逃逸') await symlink(join(root, 'outside'), join(source, 'references', 'escape'));
    await writeFile(join(root, 'outside'), 'private');
    const registry = await SkillRegistry.discover({ roots, snapshotRoot: snapshots });
    if (problem === '内部链接逃逸') { assert(registry.diagnostics.some(d => d.code === expected)); assert.equal(registry.list().skills.length, 0); return; }
    if (problem === '同名冲突') { await assert.rejects(registry.load('local-check'), new RegExp(expected)); return; }
    if (problem === '激活前修改') { await writeFile(join(source, 'references/guide.md'), 'modified'); await assert.rejects(registry.load('local-check'), new RegExp(expected)); return; }
    const loaded = await registry.load('local-check');
    if (problem === '路径穿越') { await assert.rejects(registry.read(loaded.skillId, '../outside', loaded.skillVersion), new RegExp(expected)); return; }
    if (problem === '恢复缺少版本') { await assert.rejects(registry.load(loaded.skillId, 'missing'), new RegExp(expected)); return; }
    await writeFile(join(source, 'references/guide.md'), 'modified');
    assert((await registry.read(loaded.skillId, 'references/guide.md', loaded.skillVersion)).content.includes('真实引用'));
  } finally { await removeFixture(root); }
}
export async function isolationAcceptance() {
  for (const role of ['最终检查', '后台讨论']) {
    const f = await LocalFixture.create(role);
    try { const work = await f.flow(); assertFlow(f, work);
      await assert.rejects(readFile(join(f.source, 'runs.txt')));
      assert.equal(await readFile(join(f.backend.calls[0]!.workspace, 'dist/result.txt'), 'utf8'), 'built');
      await assert.rejects(readFile(join(f.backend.calls[0]!.workspace, '.env')));
      const data = work.localOperations!.at(-1)!.result!.data; assert.equal(data.isolated, true); assert.match(String(data.workspaceRevision), /^[a-f0-9]{64}$/);
      assert(JSON.stringify(data.outputFiles).includes('dist/result.txt'));
    } finally { await f.close(); }
  }
}
export async function cliFailureAcceptance(fault: string, expected: string) {
  const f = await LocalFixture.create(); f.backend.before = undefined;
  try {
    const actions: Record<string, LocalAction> = {
      命令缺失: { type: 'runCli', executable: 'squad-no-such-cli', args: [] },
      非零退出: { type: 'runCli', executable: 'node', args: ['-e', 'process.exit(7)'] },
      超时: { type: 'runCli', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 },
      取消与后代: { type: 'runCli', executable: 'node', args: ['-e', `const{spawn}=require('child_process');spawn(process.execPath,['-e',"setInterval(()=>require('fs').appendFileSync('descendant.txt','x'),10)"],{stdio:'ignore'});setInterval(()=>{},1000)`] },
      大量输出: { type: 'runCli', executable: 'node', args: ['-e', "process.stdout.write(String.fromCharCode(0).repeat(200000));process.stderr.write(String.fromCharCode(1).repeat(200000))"] },
      沙箱不可用: { type: 'runCli', executable: 'node', args: ['-e', "require('fs').writeFileSync('must-not-run','x')"] },
    };
    if (fault === '沙箱不可用') Object.defineProperty(f.runtime, 'backend', { value: { available: false, execute: async () => { throw new Error('must not execute'); } } });
    const work = f.h.claim(); const action = actions[fault]!;
    const requested = f.h.engine.requestLocal(f.h.room, f.h.task, work.id, work.attempt, action, [], f.runtime.workspaceId(work));
    const claimed = f.h.engine.claimLocal(f.h.room, f.h.task, work.id, requested.id, work.attempt).operation!;
    const controller = new AbortController();
    const timer = fault === '取消与后代' ? setTimeout(() => controller.abort(), 180) : undefined;
    let result;
    try { result = await f.runtime.execute(work, claimed, controller.signal, metadata => { f.h.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: claimed.id, sessionId: claimed.sessionId!, ...metadata }); }); }
    finally { if (timer) clearTimeout(timer); }
    assert(result.settled, JSON.stringify(result));
    if (expected === 'truncated') { assert.equal(result.result.data.truncated, true); assert(String(result.result.data.stdout).length <= 16_000); assert(Number(result.result.data.logBytes) <= 128_000); }
    else assert.equal(result.result.code, expected);
    const journal = await f.runtime.journal.read(claimed.sessionId!); assert.equal(journal?.phase, 'settled');
    if (fault === '取消与后代') {
      const before = await readFile(join(f.source, 'descendant.txt'), 'utf8').catch(() => ''); await delay(100);
      assert.equal(await readFile(join(f.source, 'descendant.txt'), 'utf8').catch(() => ''), before);
    }
    if (fault === '沙箱不可用') { assert.equal(f.backend.calls.length, 0); await assert.rejects(readFile(join(f.source, 'must-not-run'))); }
  } finally { await f.close(); }
}
export async function crashAcceptance(window: string) {
  const f = await LocalFixture.create('方案师', true); f.backend.before = undefined;
  let currentStore = f.h.store;
  try {
    const work = f.h.claim(); const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "require('fs').appendFileSync('once.txt','x'); console.log('durable-receipt')"] };
    let op: LocalOperation | undefined;
    if (window !== '保存前') op = f.h.engine.requestLocal(f.h.room, f.h.task, work.id, work.attempt, action, [{ role: 'assistant', content: JSON.stringify(action) }], f.runtime.workspaceId(work));
    if (['领取后启动前', '启动后回执前', '回执后模型前'].includes(window)) op = f.h.engine.claimLocal(f.h.room, f.h.task, work.id, op!.id, work.attempt).operation!;
    if (['启动后回执前', '回执后模型前'].includes(window)) {
      const completion = await f.runtime.execute(work, op!, new AbortController().signal, metadata => { assert(f.h.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op!.id, sessionId: op!.sessionId!, ...metadata }).ok); });
      assert(completion.result.ok);
      if (window === '回执后模型前') assert(f.h.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op!.id, sessionId: op!.sessionId!, ...completion }).ok);
    }
    currentStore.close(); currentStore = new SqliteStore(join(f.root, 'team.sqlite')); f.h.engine = new TeamEngine(currentStore, f.h.config, () => f.h.now); f.h.engine.recover(f.h.room);
    const uncertain = f.h.context().intents.find(w => w.id === work.id)!.localOperations?.find(o => o.status === 'uncertain');
    if (uncertain) {
      const receipt = await f.runtime.reconcile(uncertain); assert(receipt);
      assert(f.h.event({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: uncertain.id, sessionId: uncertain.sessionId!, ...receipt }).ok);
    }
    if (window === '保存前') f.replies.push(action);
    f.replies.push({ type: 'answer', text: '根据真实回执续办' });
    await f.runner().runOne(f.h.room, f.h.task);
    assert.equal(f.backend.calls.length, 1); assert.equal(await readFile(join(f.source, 'once.txt'), 'utf8'), 'x');
    assert.equal(f.h.context().intents.find(w => w.id === work.id)!.localOperations?.length, 1);
    assert(f.requests.at(-1)!.messages.some(m => m.content.includes('durable-receipt')));
  } finally {
    currentStore.close(); await f.runtime.close(); await removeFixture(f.root);
  }
}
export async function formatAcceptance() {
  const f = await LocalFixture.create(); try {
    f.replies.push(...f.actions(), '{bad', { type: 'answer', text: '格式修复后交付' }); await f.runner().runOne(f.h.room, f.h.task);
    assert.equal(f.backend.calls.length, 1); assert.equal(await readFile(join(f.source, 'runs.txt'), 'utf8'), 'once\n');
    assert(f.requests.at(-1)!.messages.some(m => m.content.includes('skill-ok')));
  } finally { await f.close(); }
}
export async function serviceAcceptance() {
  const f = await LocalFixture.create(); f.backend.before = undefined;
  let service: WebService | undefined;
  try {
    const config = localConfig(); const replies: unknown[] = [...f.actions(), { type: 'answer', text: '真实执行完成' }];
    const adapter = new OpenAICompatibleAdapter(config, { transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      return modelResponse(request.messages[0]!.content.includes('executing check work') ? { type: 'check', passed: true, gaps: [] } : replies.shift());
    } });
    service = new WebService(config, join(f.root, 'web.sqlite'), adapter, undefined, false, f.runtime); await service.ready();
    const room = service.createRoom(); service.submit(room.id, { id: 'local-web', text: '运行技能验证' });
    for (let n = 0; n < 200; n++) { if (service.snapshot(room.id).tasks[0]?.outcome === 'complete') break; await delay(10); }
    const snapshot = service.snapshot(room.id); assert.equal(snapshot.tasks[0]?.outcome, 'complete');
    for (const title of ['激活本地技能', '读取技能资源', '执行本地命令', '本地命令结束']) assert(snapshot.events.some(e => e.title === title), title);
    assert(snapshot.events.some(e => e.title === '本地命令结束' && e.detail.includes('exitCode') && e.detail.includes('skill-ok')));
    const context = service.engine.view(room.id, snapshot.tasks[0]!.id)!.context;
    assert(context.intents.some(w => w.localCheckpoint?.messages.some(m => m.content.includes('skill-ok'))));
    assert(!JSON.stringify([snapshot, context]).includes('host-model-secret'));
  } finally { await service?.close(); await f.close(); }
}
export function permissionAcceptance() {
  const m = new LocalModel(); m.request(); m.claim(); m.started(); m.send({ type: 'RECOVER', config: { ...localModelInput().config, localTools: { enabled: false } } });
  assert.equal(m.op?.status, 'uncertain'); m.result();
  const work = m.c.intents[0]!; m.send({ type: 'CLAIM', intentId: work.id }); m.work = m.c.intents[0]!;
  assert.equal(m.request().code, 'LOCAL_TOOLS_DISABLED'); assert.equal(m.c.candidate, null);
}
export async function policyAcceptance() {
  const policy = sandboxPolicy({ workspace: '/task', skillPath: '/snapshot' }); assert(policy.filesystem.denyRead.includes('/')); assert(policy.filesystem.denyRead.some(p => typeof p !== 'string' && p.path === process.cwd()));
  assert.deepEqual(policy.network.allowedDomains, []); assert.deepEqual(policy.network.deniedDomains, ['*']);
  const env = minimalCliEnvironment('/task'); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.HOME, '/task/.home');
  const backend = await SandboxCliBackend.create(); try {
    if (!backend.available) {
      const result = await backend.execute({ executable: '/bin/echo', args: ['must-not-run'], cwd: '/task', workspace: '/task', env, timeoutMs: 100, sessionId: 'unavailable', logPath: '/unused' }, new AbortController().signal, async () => { assert.fail('must not spawn'); });
      assert.equal(result.result.code, 'CLI_SANDBOX_UNAVAILABLE');
    }
  } finally { await backend.close(); }
}

export async function acknowledgementAcceptance() {
  const f = await LocalFixture.create(); f.backend.before = undefined;
  try {
    const work = f.h.claim(); const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "require('fs').writeFileSync('effect.txt','written')"] };
    const requested = f.h.engine.requestLocal(f.h.room, f.h.task, work.id, work.attempt, action, [], f.runtime.workspaceId(work));
    const op = f.h.engine.claimLocal(f.h.room, f.h.task, work.id, requested.id, work.attempt).operation!;
    const result = await f.runtime.execute(work, op, new AbortController().signal, metadata => { f.h.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...metadata }); });
    await f.runtime.journal.write({ operationId: op.id, sessionId: op.sessionId!, phase: 'settled', completion: { ...result, effectsKnown: false } });
    f.h.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...result, effectsKnown: false });
    const review = await f.runtime.reviewOperation(work, op); assert.equal(review.processState, 'exited');
    await writeFile(join(f.source, 'effect.txt'), 'operator saw a newer change');
    await assert.rejects(f.runtime.acknowledgeOperation(work, op, review.reviewDigest), /LOCAL_REVIEW_STALE/);
    const current = await f.runtime.reviewOperation(work, op);
    const receipt = await f.runtime.acknowledgeOperation(work, op, current.reviewDigest);
    assert(f.h.event({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...receipt }).ok);
    assert.equal(f.h.context().intents[0]!.localOperations![0]!.status, 'succeeded'); assert.equal(f.backend.calls.length, 1);
    const pending = { ...op, id: `${op.id}:still-running`, sessionId: 'unconfirmed-session' };
    await f.runtime.journal.write({ operationId: pending.id, sessionId: pending.sessionId, phase: 'prepared' });
    const unconfirmed = await f.runtime.reviewOperation(work, pending);
    await assert.rejects(f.runtime.acknowledgeOperation(work, pending, unconfirmed.reviewDigest), /LOCAL_SESSION_NOT_SETTLED/);
  } finally { await f.close(); }
}

export async function serviceRecoveryAcceptance(uncertain = false) {
  const f = await LocalFixture.create('方案师', true, true); f.backend.before = undefined;
  let service: WebService | undefined;
  try {
    const work = f.h.claim();
    const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "require('fs').appendFileSync('once.txt','x');console.log('recovered-output')"] };
    const request = f.h.engine.requestLocal(f.h.room, f.h.task, work.id, work.attempt, action, [{ role: 'assistant', content: JSON.stringify(action) }], f.runtime.workspaceId(work));
    const op = f.h.engine.claimLocal(f.h.room, f.h.task, work.id, request.id, work.attempt).operation!;
    if (uncertain) await f.runtime.journal.write({ operationId: op.id, sessionId: op.sessionId!, phase: 'prepared' });
    else {
      const result = await f.runtime.execute(work, op, new AbortController().signal, metadata => { assert(f.h.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...metadata }).ok); });
      assert(result.result.ok); // process receipt committed, DB result deliberately missing
    }
    const { DatabaseSync } = await import('node:sqlite'); const metadata = new DatabaseSync(join(f.root, 'team.sqlite'));
    metadata.exec('CREATE TABLE web_rooms(id TEXT PRIMARY KEY,title TEXT,createdAt INTEGER)');
    metadata.prepare('INSERT INTO web_rooms VALUES(?,?,?)').run(f.h.room, '恢复验收', Date.now()); metadata.close(); f.h.store.close();
    let requests = 0;
    const adapter = new OpenAICompatibleAdapter(f.h.config, { transport: async (_url, init) => {
      requests++; const parsed = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      if (parsed.messages[0]!.content.includes('executing check work')) return modelResponse({ type: 'check', passed: true, gaps: [] });
      assert(parsed.messages.some(m => m.content.includes('recovered-output'))); return modelResponse({ type: 'answer', text: '依据已保存的 CLI 回执继续' });
    } });
    service = new WebService(f.h.config, join(f.root, 'team.sqlite'), adapter, undefined, false, f.runtime); await service.ready();
    if (uncertain) {
      await delay(40); const context = service.engine.view(f.h.room)!.context;
      assert.equal(context.intents.find(w => w.id === work.id)!.status, 'uncertain'); assert.equal(requests, 0); assert.equal(f.backend.calls.length, 0);
      assert(service.snapshot(f.h.room).events.some(e => e.title === '本地操作等待核对'));
    } else {
      for (let n = 0; n < 100; n++) { if (service.snapshot(f.h.room).tasks[0]?.outcome === 'complete') break; await delay(10); }
      const snapshot = service.snapshot(f.h.room); assert.equal(snapshot.tasks[0]?.outcome, 'complete'); assert.equal(f.backend.calls.length, 1);
      assert(snapshot.events.some(e => e.title === '已核对本地操作回执' && e.detail.includes('recovered-output')));
      assert.equal(await readFile(join(f.source, 'once.txt'), 'utf8'), 'x');
    }
  } finally { await service?.close(); await f.runtime.close(); await removeFixture(f.root); }
}

export async function namespaceAcceptance() {
  const { LocalRuntime } = await import('../src/local-runtime.js');
  const { ControlledProcessBackend } = await import('./local-tools-fixture.js');
  const root = await mkdtemp(join(tmpdir(), 'squad-namespace-')); const backend = new ControlledProcessBackend();
  const runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), skillRoots: [], backend, clock: () => 0 });
  const store = new MemoryStore(), engine = new TeamEngine(store, configuration(), () => 0);
  try {
    for (const room of ['same-id-room-one', 'same-id-room-two']) {
      const task = engine.submit(room, { id: 'same-message', text: '写入任务工作区' }).taskId!;
      const runner = new WorkRunner(engine, { execute: async (work, signal, scope) => {
        assert(scope.localTools);
        const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', `require('fs').writeFileSync('identity.txt',${JSON.stringify(room)})`] };
        const result = await scope.localTools.invoke(action, [{ role: 'assistant', content: JSON.stringify(action) }], signal); assert(result.ok);
        return work.kind === 'check' ? { type: 'check', passed: true, gaps: [] } : { type: 'answer', text: '已写入受控目录' };
      } }, () => 0, globalThis.fetch, undefined, runtime);
      assert(await runner.runOne(room, task)); assert(await runner.runOne(room, task));
    }
    assert.equal(backend.calls.length, 4);
    assert.equal(new Set(backend.calls.map(call => call.workspace)).size, 4);
    for (let index = 0; index < backend.calls.length; index++) {
      assert.equal(await readFile(join(backend.calls[index]!.workspace, 'identity.txt'), 'utf8'), index < 2 ? 'same-id-room-one' : 'same-id-room-two');
    }
  } finally { store.close(); await runtime.close(); await removeFixture(root); }
}

export async function sandboxAcceptance() {
  const { TaskSandbox, debugEventTemplate } = await import('../src/task-debug.js');
  const sandbox = new TaskSandbox();
  const states: string[] = [];
  for (const type of ['CLAIM', 'LOCAL_REQUEST', 'LOCAL_CLAIM', 'LOCAL_STARTED', 'LOCAL_RESULT']) {
    sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, type)));
    const context = sandbox.snapshot.context;
    states.push(context.intents[0]!.localOperations?.[0]?.status ?? 'parent');
  }
  assert.deepEqual(states, ['parent', 'queued', 'claimed', 'running', 'succeeded']);
  const context = sandbox.snapshot.context;
  assert.equal(context.intents[0]!.status, 'inflight'); assert.equal(context.intents[0]!.localOperations![0]!.result!.data.stdout, '合成命令结果，不是真实 CLI 执行');
}

export async function concurrentAcceptance() {
  const f = await LocalFixture.create(); f.backend.before = undefined;
  try {
    let notify!: () => void; const firstStarted = new Promise<void>(resolve => { notify = resolve; });
    f.backend.before = () => notify();
    const run = (room: string, value: string, wait: number) => {
      const task = f.h.engine.submit(room, { id: 'same-message', text: '共享工程命令' }).taskId!;
      const runner = new WorkRunner(f.h.engine, { execute: async (_work, signal, scope) => {
        const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', `setTimeout(()=>{require('fs').appendFileSync('serial.txt',${JSON.stringify(value)})},${wait})`] };
        const result = await scope.localTools!.invoke(action, [{ role: 'assistant', content: JSON.stringify(action) }], signal); assert(result.ok);
        return { type: 'answer', text: '命令已结算' };
      } }, () => 0, globalThis.fetch, undefined, f.runtime);
      return { task, job: runner.runOne(room, task) };
    };
    const first = run('first-room', 'first', 200); await firstStarted;
    const second = run('second-room', 'second', 0);
    for (let n = 0; n < 20; n++) { if (f.h.engine.view('second-room', second.task)!.context.intents[0]!.localOperations?.[0]?.status === 'queued') break; await delay(5); }
    const waiting = f.h.engine.view('second-room', second.task)!.context;
    assert.equal(waiting.intents[0]!.localOperations![0]!.status, 'queued'); assert.equal(waiting.usage.ordinary, 1); assert.equal(f.backend.calls.length, 1);
    await Promise.all([first.job, second.job]); assert.equal(f.backend.calls.length, 2); assert.equal(await readFile(join(f.source, 'serial.txt'), 'utf8'), 'firstsecond');
  } finally { await f.close(); }
}
