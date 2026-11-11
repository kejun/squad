import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StateGraph } from '../../web/src/StateGraph.js';
import { Given, When, Then } from '@cucumber/cucumber';
import { initialTransition, transition } from 'xstate';
import { inspectorMachine, inspectorWindowMachine, inspectorOrigin, type InspectorFrame } from '../../src/inspector.machine.js';
import { chartEdges, chartStep } from '../../src/task-chart.js';
import { debugEventTemplate, TaskSandbox, taskGraph, type DebugFrame } from '../../src/task-debug.js';
import { persistTask } from '../../src/task.machine.js';
import { DEFAULT_PANEL_PREFERENCES, resizePanelFromDrag, type PanelSide } from '../../web/src/panel-layout.js';
import type { SpecWorld } from './steps.js';

const observerCases = new WeakMap<SpecWorld, { initial: string; operation?: string; result?: ReturnType<typeof initialTransition<typeof inspectorMachine>>[0] }>();
const frame = (value = 'running'): InspectorFrame => ({ snapshot: { value }, event: undefined });
const trusted = { type: 'CONNECT' as const, origin: inspectorOrigin, fromTarget: true };
Given('观察连接处于{string}', function (this: SpecWorld, initial: string) { observerCases.set(this, { initial }); });
When('观察连接收到{string}', function (this: SpecWorld, operation: string) {
  const state = observerCases.get(this)!; state.operation = operation;
  let [snapshot] = initialTransition(inspectorMachine, frame());
  if (state.initial === '已连接') [snapshot] = transition(inspectorMachine, snapshot, trusted);
  const send = (event: Parameters<typeof transition<typeof inspectorMachine>>[2]) => { [snapshot] = transition(inspectorMachine, snapshot, event); };
  if (operation === '更新选择后握手') { send({ type: 'UPDATE', frame: frame('ended') }); assert.equal(snapshot.context.delivery, null); send(trusted); }
  else if (operation === '更新选择') send({ type: 'UPDATE', frame: frame('ended') });
  else if (operation === '错误窗口握手') send({ ...trusted, fromTarget: false });
  else if (operation === '外部来源握手') send({ ...trusted, origin: 'https://example.org' });
  else if (operation === '不透明来源握手') send({ ...trusted, origin: 'null' });
  else if (operation === '重复可信握手') send(trusted);
  else if (operation === '切换选择') send({ type: 'SELECT', frame: frame('ended') });
  else if (operation === '关闭') send({ type: 'CLOSE' });
  else {
    send({ type: 'CLOSE' });
    if (operation === '关闭后握手') send(trusted);
    else if (operation === '关闭后更新') send({ type: 'UPDATE', frame: frame('ended') });
    else { assert.equal(operation, '关闭后切换'); send({ type: 'SELECT', frame: frame('ended') }); }
  }
  state.result = snapshot;
});
Then('观察连接应给出{string}', function (this: SpecWorld, outcome: string) {
  const state = observerCases.get(this)!, actual = state.result!;
  const expected: Record<string, { value: string; delivery: unknown }> = {
    注册最新选择: { value: 'connected', delivery: { sequence: 1, kind: 'register', frame: frame('ended') } },
    顺序递增更新: { value: 'connected', delivery: { sequence: 2, kind: 'update', frame: frame('ended') } },
    拒绝不可信握手: { value: 'waiting', delivery: null },
    重新注册当前选择: { value: 'connected', delivery: { sequence: 2, kind: 'register', frame: frame() } },
    注册新选择: { value: 'connected', delivery: { sequence: 2, kind: 'register', frame: frame('ended') } },
    保持关闭及断开通知: { value: 'closed', delivery: { sequence: 2, kind: 'disconnect', frame: frame() } },
    关闭且不发送: { value: 'closed', delivery: null },
  };
  assert(Object.hasOwn(expected, outcome)); assert.deepEqual({ value: actual.value, delivery: actual.context.delivery }, expected[outcome]);
});

const windowCases = new WeakMap<SpecWorld, { initial: string; result?: ReturnType<typeof initialTransition<typeof inspectorWindowMachine>>[0] }>();
Given('Inspector标签页生命周期处于{string}', function (this: SpecWorld, initial: string) { windowCases.set(this, { initial }); });
When('Inspector标签页处理{string}', function (this: SpecWorld, operation: string) {
  const state = windowCases.get(this)!; let [snapshot] = initialTransition(inspectorWindowMachine);
  const send = (event: Parameters<typeof transition<typeof inspectorWindowMachine>>[2]) => { [snapshot] = transition(inspectorWindowMachine, snapshot, event); };
  if (state.initial !== '关闭') { send({ type: 'OPEN' }); send({ type: 'OPENED' }); }
  if (state.initial === '已释放') send({ type: 'DISPOSE' });
  if (operation === '首次打开' || operation === '再次打开') send({ type: 'OPEN' });
  else if (operation === '阻止后重试') { send({ type: 'OPEN' }); send({ type: 'BLOCKED' }); send({ type: 'OPEN' }); }
  else if (operation === '关闭后重开') { send({ type: 'WINDOW_CLOSED' }); assert.equal(snapshot.context.effect?.kind, 'disconnect'); send({ type: 'OPEN' }); }
  else { const type = ({ 迟到打开成功: 'OPENED', 迟到打开: 'OPEN', 迟到关闭: 'WINDOW_CLOSED' } as const)[operation]; assert(type); send({ type }); }
  state.result = snapshot;
});
Then('标签页应给出{string}', function (this: SpecWorld, outcome: string) {
  const actual = windowCases.get(this)!.result!;
  const expected: Record<string, { value: string; effect: unknown }> = {
    首次打开意图: { value: 'opening', effect: { kind: 'open', sequence: 1 } },
    聚焦原标签页: { value: 'open', effect: { kind: 'focus', sequence: 2 } },
    新重试打开意图: { value: 'opening', effect: { kind: 'open', sequence: 2 } },
    新替代打开意图: { value: 'opening', effect: { kind: 'open', sequence: 3 } },
    保持释放: { value: 'disposed', effect: { kind: 'disconnect', sequence: 2 } },
  };
  assert(Object.hasOwn(expected, outcome)); assert.deepEqual({ value: actual.value, effect: actual.context.effect }, expected[outcome]);
});

const paths = new WeakMap<SpecWorld, { box: TaskSandbox; frame?: DebugFrame; result?: ReturnType<typeof chartStep>; before?: unknown; head?: string }>();
Given('路径查看使用一个初始沙箱', function (this: SpecWorld) { paths.set(this, { box: new TaskSandbox() }); });
When('沙箱执行路径用例{string}', function (this: SpecWorld, operation: string) {
  const state = paths.get(this)!, box = state.box;
  const send = (type: string) => box.send(JSON.stringify(debugEventTemplate(box.snapshot, type)));
  if (operation === '求助') send('HELP');
  else if (operation === '向自己求助') box.send(JSON.stringify({ ...debugEventTemplate(box.snapshot, 'HELP'), target: 'A' }));
  else if (operation === '协助结果后重试') { send('HELP'); send('RECORD_RESULT'); send('RETRY_ASSISTANCE'); }
  else if (operation === '停止') send('STOP');
  else if (operation === '停止后重复停止') { send('STOP'); send('STOP'); }
  else { assert.equal(operation, '停止后继续'); send('STOP'); send('CONTINUE'); }
  state.frame = box.history.at(-1)!; state.before = persistTask(box.snapshot); state.head = box.headId;
  state.result = chartStep(taskGraph(), state.frame);
});
Then('路径应完整记录{string}', function (this: SpecWorld, expected: string) {
  const { result, box, before, head } = paths.get(this)!; assert(result); assert.equal(result.status, 'recorded');
  const graph = taskGraph();
  const ruleId = (source: string, event: string, guard?: string) => {
    const rules = graph.transitions.filter(rule => rule.source === source && rule.event === event
      && (guard ? rule.guards.includes(guard) : rule.guards.length === 0));
    assert.equal(rules.length, 1, `semantic rule must be unambiguous: ${source}/${event}/${guard ?? 'unconditional'}`);
    return rules[0]!.id;
  };
  const outcomes: Record<string, { steps: unknown[]; rules: string[] }> = {
    求助转移: { steps: [['running', 'waitingAssistance', false]], rules: [ruleId('running', 'HELP', 'valid')] },
    自依赖拒绝: { steps: [['running', 'running', false]], rules: [ruleId('*', '*')] },
    停止及自动结算: { steps: [['running', 'stopping', false], ['stopping', 'ended', true]], rules: [ruleId('*', 'STOP', 'valid'), ruleId('stopping', '@always', 'stoppedSettled')] },
    重复停止空处理: { steps: [['ended', 'ended', false]], rules: [ruleId('ended', 'STOP')] },
    全局协助重试: { steps: [['waitingAssistance', 'running', false]], rules: [ruleId('*', 'RETRY_ASSISTANCE', 'retryHasResult')] },
    结束后继续: { steps: [['ended', 'running', false]], rules: [ruleId('ended', 'CONTINUE', 'valid')] },
  };
  assert(Object.hasOwn(outcomes, expected));
  assert.deepEqual(result.steps.map(step => [step.from, step.phase, step.automatic]), outcomes[expected]!.steps);
  assert.deepEqual(result.rules.map(rule => rule.id), outcomes[expected]!.rules);
  if (expected === '全局协助重试') {
    const markup = renderToStaticMarkup(createElement(StateGraph, { graph, active: 'running', focus: 'running', frame: paths.get(this)!.frame, onFocus() {} }));
    const local = chartEdges(graph).find(edge => edge.source === 'waitingAssistance' && edge.target === 'running'); assert(local);
    assert(markup.includes(`等待协助 到 执行中 的${local.rules.length}条规则`)); assert(!markup.includes('is-recorded'));
  }
  if (expected === '自依赖拒绝') assert.equal(box.snapshot.context.reply.code, 'SELF_DEPENDENCY');
  if (expected === '重复停止空处理') { assert.deepEqual(result.steps[0]?.changed, []); assert.deepEqual(result.rules[0]?.actions, []); }
  assert.deepEqual(persistTask(box.snapshot), before); assert.equal(box.headId, head);
});

const layoutCases = new WeakMap<SpecWorld, { side: PanelSide; requested: number; viewport: number; open: boolean; saved: Readonly<typeof DEFAULT_PANEL_PREFERENCES>; result?: typeof DEFAULT_PANEL_PREFERENCES }>();
Given('不自动收起导航的调整条件为{string}', function (this: SpecWorld, condition: string) {
  const samples: Record<string, { side: PanelSide; requested: number; viewport: number; open: boolean; rightWidth: number }> = {
    详情覆盖层: { side: 'right', requested: 5000, viewport: 800, open: true, rightWidth: 352 },
    移动详情: { side: 'right', requested: 5000, viewport: 390, open: true, rightWidth: 352 },
    左栏拖动: { side: 'left', requested: 5000, viewport: 1440, open: true, rightWidth: 352 },
    详情关闭: { side: 'right', requested: 5000, viewport: 1440, open: false, rightWidth: 352 },
    非法宽度: { side: 'right', requested: Number.NaN, viewport: 1440, open: true, rightWidth: 352 },
    宽度未变: { side: 'right', requested: 828, viewport: 1440, open: true, rightWidth: 828 },
    反向缩窄: { side: 'right', requested: 800, viewport: 1440, open: true, rightWidth: 828 },
  };
  const sample = samples[condition]; assert(sample); layoutCases.set(this, { ...sample, saved: Object.freeze({ ...DEFAULT_PANEL_PREFERENCES, rightWidth: sample.rightWidth }) });
});
When('按该条件预览面板调整', function (this: SpecWorld) { const s = layoutCases.get(this)!; s.result = resizePanelFromDrag(s.saved, s.side, s.requested, s.viewport, s.open); });
Then('导航应仍然展开且原偏好不被修改', function (this: SpecWorld) { const s = layoutCases.get(this)!; assert.equal(s.result!.leftCollapsed, false); assert.equal(s.saved.leftCollapsed, false); });
