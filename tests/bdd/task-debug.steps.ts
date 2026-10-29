import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { debugEventTemplate, debugFrame, debugInput, TaskSandbox, taskGraph, type DebugFeed, type DebugFrame } from '../../src/task-debug.js';
import { initialTask, persistTask, stepTask, taskMachine } from '../../src/task.machine.js';
import { TeamEngine } from '../../src/engine.js';
import { MemoryStore } from '../../src/store.js';
import { DebugJournal } from '../../src/web/debug-journal.js';
import { Workspace } from '../../web/src/App.js';
import { debugHost, sandboxBoundary } from '../task-debug-fixture.js';
import { DebugUIFixture } from '../task-debug-ui-fixture.js';
import type { SpecWorld } from './steps.js';
import { assertDefaultUI, assertDraftHistory, assertForkUI, prepareDraftHistory, prepareForkUI, verifyDiagnosticPaths,
  verifyExpiredAndBudget, verifyLegacyGap, verifyPreviewAndHead, verifyRetryAndEmpty, verifyStableGraph } from '../task-debug-behavior.js';

interface State {
  sandbox: TaskSandbox; host?: Awaited<ReturnType<typeof debugHost>>; ui?: DebugUIFixture;
  result?: string; error?: unknown; before?: unknown; baseline?: unknown; feed?: DebugFeed;
  store?: MemoryStore; engine?: TeamEngine; observed: DebugFrame[]; count?: number; graph?: ReturnType<typeof taskGraph>;
  phases: string[]; branch?: TaskSandbox; sourceSandbox?: string;
}
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld): State {
  let s = states.get(world);
  if (!s) { s = { sandbox: new TaskSandbox(), observed: [], phases: [] }; states.set(world, s); }
  return s;
}
After(async function (this: SpecWorld) {
  const s = states.get(this); if (!s) return;
  await s.ui?.close(); await s.host?.close(); states.delete(this);
});
Given('宿主没有开启状态机调试', async function (this: SpecWorld) { state(this).host = await debugHost(false); });
When('请求调试能力和任务快照', async function (this: SpecWorld) {
  const s = state(this), host = s.host!;
  const capability = await (await fetch(host.url + '/api/debug')).json() as { enabled: boolean };
  assert.equal(capability.enabled, false); s.result = String((await fetch(host.url + host.route)).status);
});
Then('能力应为关闭且快照接口返回404', function (this: SpecWorld) { assert.equal(state(this).result, '404'); });
Then('普通网页不应出现状态机调试入口', function () {
  const workspace = { rooms: [], roomId: null, snapshot: null, connected: true, error: '', setError: () => {}, chooseRoom: () => {},
    createRoom: async () => '', refreshRooms: async () => [] };
  assert(!renderToStaticMarkup(createElement(Workspace, { workspace })).includes('打开状态机调试'));
});
Given('浏览器加载当前任务状态机', function (this: SpecWorld) { state(this); });
When('提取状态和转移结构', function (this: SpecWorld) { state(this).graph = taskGraph(); });
Then('图中应包含源码的所有状态和全局转移', function (this: SpecWorld) {
  const graph = state(this).graph!; assert.deepEqual(graph.states, Object.keys(taskMachine.config.states!));
  assert(graph.transitions.some(t => t.source === '*' && t.event === 'STOP' && t.target === 'stopping'));
});
Then('应包含输入解析状态以及守卫动作名称', function (this: SpecWorld) {
  const graph = state(this).graph!; assert(graph.states.includes('interpreting'));
  assert(graph.transitions.some(t => t.guards.includes('valid') && t.actions.includes('apply')));
});
Given('一个没有外部执行器的初始调试沙箱', function (this: SpecWorld) { const s = state(this); s.baseline = persistTask(s.sandbox.snapshot); });
When('在沙箱依次发送求助和协助结果', function (this: SpecWorld) {
  const s = state(this), before = s.sandbox.snapshot;
  const help = s.sandbox.send(JSON.stringify(debugEventTemplate(before, 'HELP'))); s.phases.push(String(help.value));
  const event = s.sandbox.history.at(-1)!.event as Parameters<typeof stepTask>[1];
  assert.deepEqual(persistTask(help), persistTask(stepTask(before, event)));
  s.sandbox.send(JSON.stringify(debugEventTemplate(help, 'HELP_RESULT'))); s.phases.push(String(s.sandbox.snapshot.value));
});
Then('状态应依次为等待协助和执行中', function (this: SpecWorld) { assert.deepEqual(state(this).phases, ['waitingAssistance', 'running']); });
Then('沙箱结果应与纯状态转换一致', function (this: SpecWorld) {
  const s = state(this), first = initialTask(debugInput());
  const next = s.sandbox.history.slice(1).reduce((snapshot, frame) => stepTask(snapshot, frame.event as Parameters<typeof stepTask>[1]), first);
  assert.deepEqual(persistTask(next), persistTask(s.sandbox.snapshot));
});
When('在沙箱执行边界场景{string}', function (this: SpecWorld, scenario: string) { const s = state(this); s.result = sandboxBoundary(s.sandbox, scenario); });
Then('应显示沙箱边界结果{string}', function (this: SpecWorld, result: string) { assert.equal(state(this).result, result); });
When('提交格式错误的沙箱事件', function (this: SpecWorld) {
  const s = state(this); s.before = persistTask(s.sandbox.snapshot);
  try { s.sandbox.send('{'); } catch (error) { s.error = error; }
});
Then('沙箱快照和历史应保持不变并显示错误', function (this: SpecWorld) {
  const s = state(this); assert(s.error instanceof Error && s.error.message.includes('JSON'));
  assert.equal(s.sandbox.history.length, 1); assert.deepEqual(persistTask(s.sandbox.snapshot), s.before);
});
When('执行有效事件后从起点创建独立分支并执行', function (this: SpecWorld) {
  const s = state(this); s.sandbox.send(JSON.stringify(debugEventTemplate(s.sandbox.snapshot, 'HELP'))); s.sandbox.send('{"type":"STOP"}');
  s.before = structuredClone(s.sandbox.history); s.sandbox.select(0); s.branch = s.sandbox.fork();
  s.branch.send('{"type":"WAIT_USER","question":"下一步"}');
});
Then('原轨迹应保留且分支可追溯并重置到自身基线', function (this: SpecWorld) {
  const s = state(this); assert.deepEqual(s.sandbox.history, s.before); assert.equal(s.branch!.history.length, 2);
  assert.equal(s.branch!.snapshot.value, 'waitingHuman'); assert.equal(s.branch!.origin!.stepId, s.sandbox.history[0]!.stepId);
  assert.equal(s.branch!.history[0]!.event.type, '@baseline'); s.branch!.reset(); assert.deepEqual(persistTask(s.branch!.snapshot), s.baseline);
});
Given('一个启用提交观测的事务引擎', function (this: SpecWorld) {
  const s = state(this); s.store = new MemoryStore();
  s.engine = new TeamEngine(s.store, debugInput().config, () => 0, (_room, frame) => s.observed.push(frame));
  s.engine.submit('room', { id: 'first', text: '形成方案' }); s.before = s.store.read('room'); s.count = s.observed.length;
});
When('事务被注入提交失败', function (this: SpecWorld) {
  const s = state(this); s.store!.failNextCommit = true;
  assert.throws(() => s.engine!.send('room', 'task:first', { type: 'STOP', id: 'failed-stop', at: 1 }));
});
Then('不应发布该事务的状态或事件', function (this: SpecWorld) {
  const s = state(this); assert.equal(s.observed.length, s.count); assert.deepEqual(s.store!.read('room'), s.before);
});
When('新引擎的观测回调抛出错误', function (this: SpecWorld) {
  const s = state(this); s.engine = new TeamEngine(s.store!, debugInput().config, () => 2, () => { throw new Error('观测断开'); });
  assert(s.engine.send('room', 'task:first', { type: 'STOP', id: 'stop', at: 2 }).ok);
  assert(s.engine.send('room', 'task:first', { type: 'CONTINUE', id: 'continue', at: 3 }).ok);
});
Then('业务仍应成功提交并接受后续命令', function (this: SpecWorld) { assert.equal(state(this).engine!.view('room', 'task:first')!.phase, 'running'); });
Given('一个启用状态机调试的网页宿主', async function (this: SpecWorld) { state(this).host = await debugHost(); });
When('同一任务快速经历求助和协助结果', function (this: SpecWorld) {
  const host = state(this).host!;
  assert(host.service.engine.send(host.room.id, host.taskId, { type: 'HELP', id: 'help', at: 1, requestId: 'H1', caller: 'A', target: 'B', question: '核对', expected: '依据' }).ok);
  assert(host.service.engine.send(host.room.id, host.taskId, { type: 'HELP_RESULT', id: 'result', at: 2, requestId: 'H1', resultId: 'R1', status: 'success', answer: '有依据' }).ok);
});
Then('调试接口应按序保留两次转移和当前快照', async function (this: SpecWorld) {
  const s = state(this), host = s.host!; s.feed = await (await fetch(host.url + host.route)).json() as DebugFeed;
  assert.deepEqual(s.feed.records.map(r => r.phase), ['running', 'waitingAssistance', 'running']); assert.equal(s.feed.current!.taskId, host.taskId);
});
Then('重复命令不应产生重复观测', function (this: SpecWorld) {
  const s = state(this), host = s.host!;
  host.service.engine.send(host.room.id, host.taskId, { type: 'HELP', id: 'help', at: 1, requestId: 'H1', caller: 'A', target: 'B', question: '核对', expected: '依据' });
  assert.equal(host.service.debugSnapshot(host.room.id, s.feed!.cursor, s.feed!.sessionId).records.length, 0);
});
Then('其他群不应读到该任务的观测', function (this: SpecWorld) {
  const host = state(this).host!, second = host.service.createRoom('其他群'); assert.equal(host.service.debugSnapshot(second.id).records.length, 0);
});
Then('过期游标和不同进程会话应明确要求重新同步', function (this: SpecWorld) {
  const host = state(this).host!; assert(host.service.debugSnapshot(host.room.id, 0, 'old-process').truncated);
  const journal = new DebugJournal(1), frame = debugFrame(initialTask(debugInput()), { type: '@init', id: 'init', at: 0 }, null);
  journal.append('room', frame); journal.append('room', frame);
  assert(journal.read('room').truncated); assert.equal(journal.read('room').records.length, 1);
});
When('从真实任务快照创建沙箱并发送停止', function (this: SpecWorld) {
  const s = state(this), host = s.host!; s.before = host.service.engine.view(host.room.id, host.taskId); s.count = host.externalCalls;
  s.sandbox = new TaskSandbox(host.service.debugSnapshot(host.room.id).current!.snapshot); s.sandbox.send('{"type":"STOP"}');
});
Then('只有沙箱应结束而真实任务和数据库保持不变', function (this: SpecWorld) {
  const s = state(this), host = s.host!; assert.equal(s.sandbox.snapshot.value, 'ended');
  assert.deepEqual(host.service.engine.view(host.room.id, host.taskId), s.before); assert.equal(host.externalCalls, s.count);
});
Then('调试接口不得接受任意业务事件写入', async function (this: SpecWorld) {
  const host = state(this).host!; assert.equal((await fetch(host.url + host.route, { method: 'POST', body: '{"type":"STOP"}' })).status, 405);
});
Given('网页打开一个状态机调试面板', async function (this: SpecWorld) {
  const s = state(this); s.ui = new DebugUIFixture(); await s.ui.open();
});
When('在面板选择求助事件并单步执行', async function (this: SpecWorld) { await state(this).ui!.sendHelp(); });
Then('当前运行应显示等待协助并可联动图和上下文', async function (this: SpecWorld) {
  assert.equal(state(this).ui!.phase, 'waitingAssistance');
  assertDefaultUI(state(this).ui!); await state(this).ui!.click('完整状态图');
  assert.equal(document.querySelector('[aria-label="查看状态 waitingAssistance"]')!.getAttribute('data-active'), 'true');
  await state(this).ui!.disclose('完整上下文');
  assert(document.querySelector('[aria-label="任务上下文"]')!.textContent!.includes('核对恢复风险'));
});
When('在面板返回历史并重置', async function (this: SpecWorld) {
  const ui = state(this).ui!; await ui.click('当前运行'); await ui.click('查看步骤 0'); assert.equal(ui.phase, 'waitingAssistance'); assert(ui.text.includes('历史步骤')); await ui.click('重置');
});
Then('图中应高亮执行中且错误应清空', function (this: SpecWorld) { assert.equal(state(this).ui!.phase, 'running'); assert.equal(document.querySelector('[role="alert"]'), null); });
When('按Escape关闭调试面板', async function (this: SpecWorld) { await state(this).ui!.escape(); });
Then('页面应调用关闭操作', function (this: SpecWorld) { assert.equal(state(this).ui!.closed, 1); assert.equal(state(this).ui!.requests.length, 0); });

When('诊断初始化停止拒绝和讨论领取的真实状态转换', function (this: SpecWorld) { state(this).before = verifyDiagnosticPaths(); });
Then('所有最终快照应与原转换一致且停止包含自动微步', function (this: SpecWorld) {
  assert.equal((state(this).before as ReturnType<typeof verifyDiagnosticPaths>).automatic, 2);
});
Then('实际守卫应按顺序记录局部失败和全局命中', function (this: SpecWorld) {
  const value = state(this).before as ReturnType<typeof verifyDiagnosticPaths>;
  assert.deepEqual(value.fallback.filter(e => e.event === 'CLAIM').map(e => [e.guard, e.passed]), [['claimOwner', false], ['claimDiscussion', true]]);
});
When('诊断协助重试和结束后的重复停止', function (this: SpecWorld) { state(this).result = verifyRetryAndEmpty(); });
Then('应区分已命中未评估和空处理且不复用旧拒绝码', function (this: SpecWorld) { assert(state(this).result!.includes('保持不变')); assert(!state(this).result!.includes('OLD_REJECTION')); });
When('预演求助后执行并回看起点再次执行停止', function (this: SpecWorld) { state(this).sandbox = verifyPreviewAndHead(); });
Then('预演不新增历史且停止应从实验头追加而保留求助记录', function (this: SpecWorld) {
  const s = state(this); assert.deepEqual(s.sandbox.history.map(f => f.event.type), ['@init', 'HELP', 'STOP']); assert.equal(s.sandbox.history.at(-1)!.from, 'waitingAssistance');
});
Then('应在默认运行视图显示等待对象条件证据和关键变化', function (this: SpecWorld) { assertDefaultUI(state(this).ui!); });
When('编辑事件草稿并选择历史和查看规则', async function (this: SpecWorld) { await prepareDraftHistory(state(this).ui!); });
Then('草稿应保持且历史与最新位置应分开显示', function (this: SpecWorld) { assertDraftHistory(state(this).ui!); });
When('从求助前的历史步骤创建沙箱并执行等待用户', async function (this: SpecWorld) { const s = state(this); s.sourceSandbox = await prepareForkUI(s.ui!); });
Then('源沙箱的求助轨迹应保留且新沙箱应标明复制基线', async function (this: SpecWorld) { const s = state(this); await assertForkUI(s.ui!, s.sourceSandbox!); });
When('比较不同当前状态下的完整状态图与聚焦图', async function (this: SpecWorld) {
  const s = state(this); s.ui = new DebugUIFixture(); await s.ui.open(); s.count = await verifyStableGraph(s.ui);
});
Then('节点坐标应稳定且全局内部及同事件分支均可定位', function (this: SpecWorld) { assert.equal(state(this).count, taskGraph().transitions.length); });
When('查看没有条件证据的旧记录和已被裁剪的选中步骤', function (this: SpecWorld) { verifyLegacyGap(); state(this).result = '此记录未采集'; });
Then('应明确显示未采集与历史缺口且不静默跳到最新', function (this: SpecWorld) { assert.equal(state(this).result, '此记录未采集'); });
When('预演后修改参数并检查额度不足的继续事件', function (this: SpecWorld) { state(this).result = verifyExpiredAndBudget(); });
Then('旧预演应失效且继续应显示真实拒绝而不标为可执行', function (this: SpecWorld) { assert.equal(state(this).result, 'BUDGET_EXHAUSTED'); });
Given('一个读取真实调试接口的实时面板', async function (this: SpecWorld) {
  const s = state(this); s.host = await debugHost(); s.ui = new DebugUIFixture(s.host);
  await s.ui.open(); await s.ui.waitFor(() => s.ui!.phase === 'running');
});
When('历史查看期间真实引擎提交新的协助事件', async function (this: SpecWorld) {
  const s = state(this), host = s.host!; await s.ui!.click('查看步骤 0');
  host.service.engine.send(host.room.id, host.taskId, { type: 'HELP', id: 'live-help', at: 1, requestId: 'live-H', caller: 'A', target: 'B', question: '核对', expected: '依据' });
  await s.ui!.waitFor(() => s.ui!.phase === 'waitingAssistance');
});
Then('顶部应更新到最新状态且步骤详情仍停在原历史', function (this: SpecWorld) {
  assert.equal(state(this).ui!.phase, 'waitingAssistance'); assert(document.querySelector('[aria-label="步骤详情"]')!.textContent!.includes('@init'));
});
When('返回最新观测步骤', async function (this: SpecWorld) { await state(this).ui!.click('返回最新'); });
Then('详情应显示新事件及其当次条件证据', function () {
  const detail = document.querySelector('[aria-label="步骤详情"]')!.textContent!; assert(detail.includes('HELP')); assert(detail.includes('当次转换采集'));
});
