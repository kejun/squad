import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Before, Given, When, Then } from '@cucumber/cucumber';
import { defaultWindowModel, expiredPhaseModel, expiredDecisionModel, windowFailureModel, expiryPermissionModel, expiryPhysicalCustodyModel, expiryOtherDeadlineModel, expiryMapResumeModel, expiryClaimedInputResumeModel, expiryPhaseCompletionModel } from '../window-expiry-model-fixture.js';
import { windowFailureTransport } from '../window-failure-transport-fixture.js';
import { processingWindow, taskHumanGate } from '../../src/task/resilience.js';
import { ResilienceModel, stageModel } from '../task-resilience-model-fixture.js';
import type { Intent, Phase, TaskEvent } from '../../src/types.js';
import { MemoryStore, SqliteStore, TeamEngine } from '../../src/index.js';
import { resolveLocalResourcePolicy } from '../../src/local-resource-policy.js';
import { localModelInput } from '../local-model-fixture.js';

interface WindowContract { id: string; detail?: string; model?: ResilienceModel; transport?: Awaited<ReturnType<typeof windowFailureTransport>> }
const cases = new WeakMap<object, WindowContract>();
const state = (world: object) => { const value = cases.get(world); assert(value, 'window contract must have an explicit identity'); return value; };
Before({ tags: '@BT_Y131 or @BT_Y132 or @BT_Y133 or @BT_Y134' }, function ({ pickle }) {
  const id = pickle.tags.map(tag => tag.name.slice(1)).find(tag => /^BT_Y13[1-4]$/.test(tag)); assert(id); cases.set(this, { id });
});
Given('旧配置未指定窗口且沿用三小时兼容策略', function () {
  const c = state(this); assert.equal(c.id, 'BT_Y131'); c.model = new ResilienceModel(input => { delete input.config.resilience; }); assert.equal(c.model.c.config.resilience, undefined);
});
When('任务建立并经历恢复', function () { state(this).model = defaultWindowModel(state(this).model!); });
Then('原始处理窗口应恰为三小时且历史额度不变', function () {
  const m = state(this).model!; assert(m); const window = processingWindow(m.c); assert.equal(window.hardDeadline - window.openedAt, 10_800_000);
});
Given('活动任务处于窗口到期前的{string}阶段', function (phase: string) {
  assert.equal(state(this).id, 'BT_Y132'); assert(['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking'].includes(phase)); state(this).detail = phase; state(this).model = stageModel(phase as Phase); assert.equal(state(this).model!.phase, phase);
});
When('时钟到达原窗口硬期限并重复监督恢复', function () { state(this).model = expiredPhaseModel(state(this).detail as Phase, state(this).model!); });
Then('应保存WINDOW_EXPIRED并等待明确续窗决定', function () {
  const m = state(this).model!; assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); assert.equal(processingWindow(m.c).failure?.code, 'WINDOW_EXPIRED'); assert(taskHumanGate(m.c));
});
Then('原有成果和未决效果责任应保留且不得派发新业务', function () {
  const m = state(this).model!; assert(m.c.artifacts.some(item => item.id === 'current-artifact')); assert.equal(m.c.resilience!.frozen, undefined); expiryPhysicalCustodyModel();
});
Given('任务保留已有成果且原处理窗口即将到期', function () {
  const c = state(this); assert.equal(c.id, 'BT_Y133'); c.model = new ResilienceModel(); c.model.artifact(); assert.equal(c.model.c.artifacts.length, 1); assert(c.model.at < processingWindow(c.model.c).hardDeadline);
});
When('用户选择{string}', function (decision: string) { state(this).detail = decision; state(this).model = expiredDecisionModel(decision, state(this).model!); });
Then('应按明确决定续办或保留成果结束且不暗中续期', function () {
  const c = state(this), m = c.model!; assert(m);
  if (c.detail!.includes('明确授权三小时新窗口')) { assert.equal(m.phase, 'running'); assert.equal(processingWindow(m.c).hardDeadline, 10_800_100); }
  else if (c.detail!.includes('停止')) assert.equal(m.c.outcome, 'stopped');
  else if (c.detail!.includes('结束')) assert.equal(m.c.outcome, 'partial');
  else { assert.equal(m.phase, 'waitingHuman'); if (!c.detail!.startsWith('跳过旧宿主')) assert.equal(processingWindow(m.c).hardDeadline, 100); }
});
Then('历史计费和宿主命令授权边界应保持', function () { assert(state(this).model); expiryPermissionModel(); });
Then('新窗口负责人应能补齐未开始分片且保留原成功与未决操作身份', function () {
  assert(state(this).model); expiryMapResumeModel(); expiryMapResumeModel(true); expiryClaimedInputResumeModel();
  const m = expiryPhysicalCustodyModel(), old = m.c.intents.find(work => work.localOperations?.some(op => op.id === 'unknown-op'))!;
  const receipt = structuredClone(old.localOperations), gate = taskHumanGate(m.c)!;
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'newWindow', newWindowMs: 10_800_000, text: '继续但不重放旧操作' }).ok);
  assert.deepEqual(m.c.intents.find(work => work.id === old.id)!.localOperations, receipt); assert.equal(m.c.resilience!.cleanup[0]!.state, 'pending');
});
Then('各活动阶段续窗后应完成交付核验且已保存协助结果只消费一次', function () {
  assert(state(this).model);
  for (const phase of ['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking'] as Phase[]) expiryPhaseCompletionModel(phase);
  expiryPhaseCompletionModel('waitingAssistance', true);
});
Given('当前工作收到{string}失败语义', function (failure: string) {
  const c = state(this); assert.equal(c.id, 'BT_Y134'); c.detail = failure; c.model = new ResilienceModel(); const work = c.model.claim(); assert.equal(work.status, 'inflight');
});
When('系统处理该失败及其监督后继', async function () {
  const c = state(this); c.model = windowFailureModel(c.detail!, c.model!); c.transport = await windowFailureTransport(c.detail!);
});
Then('应区分窗口授权决定与原窗口内有限网络重试', function () {
  const c = state(this), m = c.model!; assert(m); assert(c.transport);
  if (c.detail!.startsWith('WINDOW_EXPIRED')) { assert.equal(m.c.usage.retries, 0); assert.equal(taskHumanGate(m.c)?.code, 'WINDOW_EXPIRED'); }
  else assert.equal(processingWindow(m.c).failure, undefined);
  expiryOtherDeadlineModel();
});

interface LegacyDeadlineCase {
  clock: { now: number };
  engine: TeamEngine;
  reopen: () => TeamEngine;
  close: () => void;
  task: string;
  tool: Intent;
  claimOther?: () => ReturnType<TeamEngine['claimLocal']>['response'];
}
const legacyDeadlines = new WeakMap<object, LegacyDeadlineCase>();
const legacyDeadline = (world: object) => { const value = legacyDeadlines.get(world); assert(value); return value; };

Given('{string}中没有CLI子记录的非幂等工具已启动且效果未确认', function (storage: string) {
  assert(['SQLite', 'Memory'].includes(storage));
  const root = storage === 'SQLite' ? mkdtempSync(join(tmpdir(), 'squad-legacy-expiry-')) : undefined;
  const filename = root && join(root, 'team.sqlite');
  let store = filename ? new SqliteStore(filename) : new MemoryStore();
  const clock = { now: 0 }, config = localModelInput().config;
  config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20 };
  const engine = new TeamEngine(store, config, () => clock.now);
  const task = engine.submit('legacy', { id: 'legacy-input', text: '执行旧工具' }).taskId!;
  const owner = engine.claim('legacy', task, engine.pending('legacy', task)[0]!.id)!;
  assert(engine.send('legacy', task, { type: 'TOOL', id: 'legacy-tool', at: clock.now, workId: owner.id, fence: owner, tool: 'read', replay: 'unsafe', payload: {} }).ok);
  const tool = engine.claim('legacy', task, engine.pending('legacy', task).find(work => work.kind === 'tool')!.id)!;
  legacyDeadlines.set(this, { clock, engine, task, tool,
    reopen: () => {
      if (filename) { store.close(); store = new SqliteStore(filename); }
      return new TeamEngine(store, config, () => clock.now);
    },
    close: () => { store.close(); if (root) rmSync(root, { recursive: true, force: true }); },
  });
  assert(!tool.localOperations?.length);
  assert(engine.beginExecution('legacy', task, tool));
  assert.equal(engine.executionPhase('legacy', task, tool), 'running');
});
After({ tags: '@BT_Y206' }, function () { legacyDeadlines.get(this)?.close(); });

When('原窗口硬期限收到{string}的两个事件', function (order: string) {
  const c = legacyDeadline(this), { engine, task, tool, clock } = c;
  clock.now = processingWindow(engine.view('legacy', task)!.context).hardDeadline;
  const other = engine.submit('other', { id: 'other-input', text: '执行另一会话的命令' }).taskId!;
  const work = engine.claim('other', other, engine.pending('other', other)[0]!.id)!;
  const policy = resolveLocalResourcePolicy({ workspaceId: 'workspace:other', isolatedWork: false,
    execution: 'sandbox', sandboxConfinesWorkspace: true, action: 'runCli' });
  const op = engine.requestLocal('other', other, work.id, work.attempt,
    { type: 'runCli', executable: 'node', args: ['never-executed.mjs'] }, [], 'workspace:other', policy);
  c.claimOther = () => c.engine.claimLocal('other', other, work.id, op.id, work.attempt).response;
  const fail: TaskEvent = { type: 'WORK_FAILED', id: 'legacy-expired', at: clock.now, intentId: tool.id, attempt: tool.attempt, fence: tool,
    code: 'WINDOW_EXPIRED', reason: 'Processing window expired during an unsafe tool invocation', transient: false, resultUncertain: true };
  const supervise: TaskEvent = { type: 'SUPERVISE', id: 'legacy-observe-expiry', at: clock.now, trigger: 'timer' };
  const failureFirst = order === '失败通知先于到期监督';
  assert(failureFirst || order === '到期监督先于失败通知');
  assert(engine.send('legacy', task, failureFirst ? fail : supervise).ok);
  assert.equal(c.claimOther().code, 'WORKSPACE_BUSY', 'first expiry transaction must preserve the persisted resource barrier');
  assert.equal(engine.send('legacy', task, failureFirst ? supervise : fail).code, failureFirst ? 'OK' : 'UNKNOWN_OR_SETTLED_WORK');
  c.engine = c.reopen();
});
Then('任务应等待明确续窗且其他会话仍不能领取冲突资源', function () {
  const { engine, task, tool, claimOther } = legacyDeadline(this), view = engine.view('legacy', task)!;
  assert.equal(view.phase, 'waitingHuman');
  assert.equal(taskHumanGate(view.context)?.cause, 'windowExpired');
  assert.equal(engine.executionPhase('legacy', task, tool), 'uncertain');
  assert.deepEqual(view.context.resilience!.cleanup.map(item => [item.kind, item.workId, item.state]), [['legacyWork', tool.id, 'pending']]);
  assert.equal(claimOther!().code, 'WORKSPACE_BUSY');
});
When('可信工具提供方核对原工作效果', function () {
  const { engine, task, tool, clock } = legacyDeadline(this);
  assert(engine.send('legacy', task, { type: 'RECONCILE', id: 'legacy-provider-receipt', at: clock.now, intentId: tool.id,
    fence: tool, resolution: 'confirmed', detail: '可信提供方核对原工作效果' }).ok);
});
Then('清理责任应结算且其他会话可以领取原先冲突的资源', function () {
  const { engine, task, tool, claimOther } = legacyDeadline(this), view = engine.view('legacy', task)!;
  assert.equal(view.context.resilience!.cleanup[0]!.state, 'settled');
  assert.equal(engine.executionPhase('legacy', task, tool), 'settled');
  assert.equal(taskHumanGate(view.context)?.cause, 'windowExpired');
  assert(claimOther!().ok);
});
