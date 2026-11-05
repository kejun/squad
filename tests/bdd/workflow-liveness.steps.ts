import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { SqliteStore, type Intent, type Phase, type TaskContext } from '../../src/index.js';
import type { HostApproval } from '../../src/local-operation.js';
import { configuration, Harness } from '../helpers.js';
import type { SpecWorld } from './steps.js';

interface SupervisionFixture {
  h: Harness;
  work?: Intent;
  phase?: Phase;
  intents?: Intent[];
  reason?: string;
}

const fixtures = new WeakMap<SpecWorld, SupervisionFixture>();
const retained = { id: 'retained-artifact', name: 'result.md', content: '已保存的阶段成果' };

function setup(world: SpecWorld, parsing = false): SupervisionFixture {
  const config = configuration({ progressIntervalMs: 10, workTimeoutMs: 1000 });
  if (parsing) config.models = { default: 'fixture', services: { fixture: { model: 'fixture', baseUrl: 'http://127.0.0.1' } } };
  const fixture = { h: new Harness(config, new SqliteStore(':memory:')) };
  fixtures.set(world, fixture);
  return fixture;
}

const state = (world: SpecWorld) => fixtures.get(world)!;

After(function (this: SpecWorld) { fixtures.get(this)?.h.store.close(); });

Given('任务到达进展检查期限时仍有执行中的主线工作', function (this: SpecWorld) {
  const fixture = setup(this), { h } = fixture;
  fixture.work = h.claim('owner');
  const { epoch, nextCheckAt } = h.context();
  h.now = nextCheckAt;
  // An older driver could commit this temporary rejection while the owner was still active.
  const legacyId = `progress:${h.task}:${epoch}:${nextCheckAt}`;
  assert.equal(h.event({ type: 'TICK', id: legacyId }).ok, false);
  h.engine.tick(h.room);
  assert.equal(h.view().phase, 'running');
  assert.equal(h.context().intents.find(work => work.id === fixture.work?.id)?.status, 'inflight');
});

When('该工作结算且任务仍需推进', function (this: SpecWorld) {
  const { h, work } = state(this);
  h.now++;
  assert(h.event({ type: 'SETTLE', intentId: work!.id, attempt: work!.attempt }).ok);
  h.engine.tick(h.room);
});

Then('应安排一次协调检查并显示进展超时原因', function (this: SpecWorld) {
  const { h } = state(this);
  assert.equal(h.view().phase, 'coordinating');
  assert.deepEqual(h.engine.pending(h.room, h.task).map(work => work.kind), ['facilitator']);
  assert.equal(h.context().reason, 'No evidenced progress by deadline');
});

Then('重复检查时不得重复派发协调工作', function (this: SpecWorld) {
  const { h } = state(this);
  const before = h.engine.pending(h.room, h.task).map(work => work.id);
  h.engine.tick(h.room);
  h.engine.tick(h.room);
  assert.deepEqual(h.engine.pending(h.room, h.task).map(work => work.id), before);
  assert.equal(h.context().intents.filter(work => work.kind === 'facilitator').length, 1);
});

const phaseByName = { 输入解析: 'interpreting', 等待协助: 'waitingAssistance', 协调: 'coordinating', 交付检查: 'checking' } as const;

function enterPhase(h: Harness, phase: Phase) {
  if (phase === 'interpreting') {
    assert(h.engine.submit(h.room, { id: 'complex-input', text: '必须保留已有约束' }).ok);
    return h.claim('interpretation');
  }
  const work = h.claim('owner');
  const identity = { workId: work.id, fence: work, attempt: work.attempt };
  if (phase === 'waitingAssistance') {
    assert(h.event({ ...identity, type: 'HELP', requestId: 'help', caller: 'A', target: 'B', question: '核对资料', expected: '证据' }).ok);
    return h.claim('assistance');
  }
  if (phase === 'coordinating') {
    assert(h.event({ ...identity, type: 'BLOCKED', reason: '需要协调' }).ok);
    return h.claim('facilitator');
  }
  assert(h.event({ ...identity, type: 'DELIVER', text: retained.content, artifactIds: [retained.id] }).ok);
  return h.claim('check');
}

Given('任务处于{string}但没有可执行的后续工作且无真实等待', function (this: SpecWorld, name: keyof typeof phaseByName) {
  const phase = phaseByName[name];
  const { h } = setup(this, phase === 'interpreting');
  assert(h.event({ type: 'ARTIFACT', artifact: retained }).ok);
  const work = enterPhase(h, phase);
  assert.equal(h.view().phase, phase);
  // Emulate a previously persisted phase whose only successor was already retired.
  h.store.transact(h.room, tx => {
    const saved = tx.room.tasks[h.task] as { snapshot: { context: TaskContext } };
    saved.snapshot.context.intents.find(intent => intent.id === work.id)!.status = 'done';
  });
  assert.deepEqual(h.engine.pending(h.room, h.task), []);
});

When('监督检查期限到达', function (this: SpecWorld) {
  const { h } = state(this);
  h.now = h.context().nextCheckAt;
  assert.equal(h.engine.nextWake(h.room), h.now);
  h.engine.tick(h.room);
});

Then('应保留已有成果并显示推进中断原因', function (this: SpecWorld) {
  const { h } = state(this), context = h.context();
  assert(context.artifacts.some(artifact => artifact.id === retained.id && artifact.content === retained.content));
  assert.match(context.reason, /推进中断/u);
});

Then('应明确结束本轮且不得发布未验收候选或重复执行', function (this: SpecWorld) {
  const { h } = state(this);
  assert.equal(h.view().phase, 'ended');
  assert.equal(h.context().outcome, 'partial');
  assert.equal(h.context().publishedDelivery, undefined);
  assert.deepEqual(h.engine.pending(h.room, h.task), []);
  const before = h.context().trace.length;
  h.engine.tick(h.room);
  assert.equal(h.context().trace.length, before);
});

function awaitHostApproval(h: Harness) {
  const work = h.claim('owner');
  const reason = '需用户同意使用宿主环境';
  const operation = h.engine.requestLocal(h.room, h.task, work.id, work.attempt,
    { type: 'runCli', executable: 'node', args: ['verify.js'], execution: 'host', reason }, [], 'test-workspace');
  const claimed = h.engine.claimLocal(h.room, h.task, work.id, operation.id, work.attempt);
  assert(claimed.response.ok && claimed.operation?.sessionId);
  const approval: HostApproval = { id: 'approval', digest: 'a'.repeat(64), status: 'pending', expiresAt: 500,
    plan: { executable: '/usr/bin/node', args: ['verify.js'], cwd: '/task', host: 'host', account: 'tester', reason,
      workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64), environmentHash: 'd'.repeat(64) } };
  assert(h.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: operation.id,
    sessionId: claimed.operation.sessionId, approval, fence: work, attempt: work.attempt }).ok);
  assert.equal(h.context().intents.find(intent => intent.id === work.id)?.localOperations?.[0]?.status, 'awaitingApproval');
}

Given('任务正在等待{string}', function (this: SpecWorld, wait: string) {
  const fixture = setup(this), { h } = fixture;
  if (wait === '用户决定') {
    assert(h.event({ type: 'WAIT_USER', question: '请选择工作区' }).ok);
    assert.equal(h.view().phase, 'waitingHuman');
  } else if (wait === '宿主审批') awaitHostApproval(h);
  else {
    assert.equal(wait, '外部效果核对');
    assert(h.event({ type: 'TOOL', tool: 'writeArtifact', replay: 'unsafe', payload: {} }).ok);
    const tool = h.claim('tool');
    h.reopen();
    assert.equal(h.context().intents.find(work => work.id === tool.id)?.status, 'uncertain');
    assert.equal(h.view().phase, 'waitingHuman');
  }
  fixture.phase = h.view().phase;
  fixture.intents = h.context().intents;
  fixture.reason = h.context().reason;
});

When('进展检查期限到达', function (this: SpecWorld) {
  const { h } = state(this);
  h.now = h.context().nextCheckAt;
  const wake = h.engine.nextWake(h.room);
  assert(wake === null || wake > h.now, '真实等待只能由自身期限唤醒');
  h.engine.tick(h.room);
});

Then('应保留原等待和已保存的工作', function (this: SpecWorld) {
  const { h, phase, reason, intents } = state(this);
  assert.equal(h.view().phase, phase);
  assert.equal(h.context().reason, reason);
  assert.deepEqual(h.context().intents, intents);
});

Then('不应为推进而发起额外执行或提前结束任务', function (this: SpecWorld) {
  const { h } = state(this);
  assert.equal(h.context().outcome, null);
  assert.deepEqual(h.engine.pending(h.room, h.task), []);
  assert(!h.context().trace.some(event => event.event === 'TICK' || event.event === 'WORKFLOW_STALLED'));
});
