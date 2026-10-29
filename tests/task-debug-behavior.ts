import assert from 'node:assert/strict';
import { debugEventTemplate, debugFrame, debugInput, taskGraph, TaskSandbox } from '../src/task-debug.js';
import { branchStatus, contextChanges, frameSummary, selectDebugFrame, waitingItems } from '../src/task-debug-view.js';
import { inspectInitialTask, inspectTask } from '../src/task-inspection.js';
import { initialTask, persistTask, stepTask } from '../src/task.machine.js';
import type { TaskEvent } from '../src/types.js';
import { plannedSandbox } from './discussion-debug-fixture.js';
import type { DebugUIFixture } from './task-debug-ui-fixture.js';

export function verifyDiagnosticPaths() {
  const input = debugInput(), initial = initialTask(input), initialized = inspectInitialTask(input);
  assert.deepEqual(persistTask(initialized.snapshot), persistTask(initial));
  const stop: TaskEvent = { type: 'STOP', id: 'stop', at: 1 }, stopped = inspectTask(initial, stop);
  assert.deepEqual(persistTask(stopped.snapshot), persistTask(stepTask(initial, stop)));
  assert.deepEqual(stopped.evidence.microsteps.map(s => s.phase), ['stopping', 'ended']);
  const owner = stepTask(initial, { ...debugEventTemplate(initial, 'CLAIM'), id: 'owner' } as TaskEvent);
  const discussion = stepTask(owner, { type: 'USER_INPUT', id: 'invite', at: 2, text: '所有人都参与讨论一下', reviewTargets: ['B'] });
  const claim = { ...debugEventTemplate(discussion, 'CLAIM'), id: 'discussion' } as TaskEvent;
  const captured = inspectTask(discussion, claim);
  assert.deepEqual(persistTask(captured.snapshot), persistTask(stepTask(discussion, claim)));
  assert.deepEqual(captured.evidence.evaluations.filter(e => e.event === 'CLAIM').map(e => [e.guard, e.passed]), [['claimOwner', false], ['claimDiscussion', true]]);
  const rejected = { ...debugEventTemplate(initial, 'HELP'), id: 'self', target: 'A' } as TaskEvent;
  assert.equal(inspectTask(initial, rejected).snapshot.context.reply.code, 'SELF_DEPENDENCY');
  return { automatic: stopped.evidence.microsteps.length, fallback: captured.evidence.evaluations };
}
export function verifyRetryAndEmpty() {
  const sandbox = new TaskSandbox();
  sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, 'HELP')));
  sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, 'RECORD_RESULT')));
  sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, 'RETRY_ASSISTANCE')));
  const frame = sandbox.history.at(-1)!, graph = taskGraph();
  assert.equal(branchStatus(graph.transitions.find(t => t.id === '*:RETRY_ASSISTANCE:2')!, frame, graph), '前一分支已命中，未评估');
  const initial = initialTask(debugInput()), ended = stepTask(initial, { type: 'STOP', id: 'stop', at: 1 });
  ended.context.reply = { ok: false, code: 'OLD_REJECTION', detail: 'old' };
  const empty = inspectTask(ended, { type: 'STOP', id: 'again', at: 2 });
  const summary = frameSummary(debugFrame(empty.snapshot, { type: 'STOP', id: 'again', at: 2 }, 'ended', empty.evidence), graph);
  assert(summary.includes('保持不变')); assert(!summary.includes('OLD_REJECTION'));
  return summary;
}
export function verifyPreviewAndHead() {
  const box = new TaskSandbox(), initial = persistTask(box.snapshot);
  const preview = box.preview(JSON.stringify(debugEventTemplate(box.snapshot, 'HELP')));
  assert.equal(preview.frame.phase, 'waitingAssistance'); assert.equal(box.history.length, 1);
  assert.deepEqual(persistTask(box.snapshot), initial);
  box.send(preview.text); box.select(0); box.send('{"type":"STOP"}');
  assert.deepEqual(box.history.map(f => f.event.type), ['@init', 'HELP', 'STOP']);
  assert.equal(box.history.at(-1)!.from, 'waitingAssistance'); assert.equal(box.snapshot.value, 'ended');
  assert.equal(box.selected!.phase, 'running');
  return box;
}
export function verifyExpiredAndBudget() {
  const box = new TaskSandbox(), text = '{"type":"STOP"}', preview = box.preview(text);
  assert(box.isPreviewCurrent(preview, text)); assert(!box.isPreviewCurrent(preview, '{"type":"CONTINUE"}'));
  box.reset(); assert(!box.isPreviewCurrent(preview, text));
  const input = debugInput(); input.config.limits.ordinary = 0;
  const limited = TaskSandbox.fromInput(JSON.stringify(input)); limited.send(text);
  const continuing = limited.preview('{"type":"CONTINUE"}');
  const snapshot = continuing.frame.snapshot as { context: { reply: { code: string } } };
  assert.equal(snapshot.context.reply.code, 'BUDGET_EXHAUSTED');
  return snapshot.context.reply.code;
}
export function finishDiscussionWithoutOwner(sandbox = plannedSandbox()) {
  for (const type of ['DISCUSSION_PLAN', 'CLAIM', 'DISCUSSION_RESULT', 'CLAIM', 'DISCUSSION_RESULT']) {
    sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, type)));
  }
  assert.equal(sandbox.snapshot.context.discussion?.status, 'ready');
  assert(sandbox.snapshot.context.intents.some(work => work.kind === 'owner' && work.status === 'inflight'));
  return sandbox;
}
export function verifyDiscussionWait(sandbox: TaskSandbox) {
  assert(waitingItems(sandbox.snapshot.context).some(item => item.text.includes('汇总已就绪') && item.text.includes('方案师当前工作结算')));
  const before = sandbox.snapshot.context, after = structuredClone(before);
  after.intents.unshift({ ...after.intents[0]!, id: 'new-work' });
  const diff = contextChanges(before, after);
  assert(diff.changes.some(item => item.path === 'intents[new-work]'));
  assert(!diff.changes.some(item => item.path.startsWith('intents[0]')));
}
export function verifyLegacyGap() {
  const frame = debugFrame(initialTask(debugInput()), { type: 'STOP', id: 'legacy', at: 1 }, 'running');
  assert(frameSummary(frame, taskGraph()).includes('未采集'));
  assert.equal(branchStatus(taskGraph().transitions[0]!, frame, taskGraph()), '此记录未采集');
  assert.equal(selectDebugFrame([frame], 'trimmed-step'), undefined);
  assert.equal(selectDebugFrame([frame], null), frame);
  const box = new TaskSandbox(); const selectedId = box.history[0]!.stepId!;
  for (let index = 0; index < 105; index++) box.send('{"type":"ACTIVITY","text":"受控活动"}');
  assert(box.truncated); assert.equal(box.history.length, 100); assert.equal(selectDebugFrame(box.history, selectedId), undefined);
  assert(box.bytes <= 4 * 1024 * 1024);
  const latest = structuredClone(box.history.at(-1)!); latest.evidence!.definition = 'other-definition';
  assert(frameSummary(latest, taskGraph()).includes('结构版本不同'));
  assert(branchStatus(taskGraph().transitions[0]!, latest, taskGraph()).includes('无法关联'));
}
export function assertDefaultUI(ui: DebugUIFixture) {
  assert.equal(ui.phase, 'waitingAssistance');
  assert(document.querySelector('[aria-label="本次运行轨迹"]'));
  assert(ui.text.includes('核查员 · 协助待领取'));
  assert(ui.text.includes('当次转换采集'));
  assert(ui.text.includes('关键变化'));
  assert.equal(document.querySelector('[aria-label="任务上下文"]'), null, 'Large JSON stays collapsed');
}
export async function prepareDraftHistory(ui: DebugUIFixture) {
  await ui.sendHelp(); await ui.disclose('高级 JSON');
  await ui.fill('事件参数 JSON', '{"type":"STOP","id":"keep-draft"}');
  await ui.click('查看步骤 0'); await ui.click('转移规则');
}
export function assertDraftHistory(ui: DebugUIFixture) {
  assert.equal((document.querySelector('[aria-label="事件参数 JSON"]') as HTMLTextAreaElement).value, '{"type":"STOP","id":"keep-draft"}');
  assert.equal(ui.phase, 'waitingAssistance'); assert(ui.text.includes('历史步骤'));
}
export async function prepareForkUI(ui: DebugUIFixture) {
  await ui.sendHelp(); const source = (document.querySelector('[aria-label="选择沙箱"]') as HTMLSelectElement).value;
  await ui.click('查看步骤 0'); await ui.click('从此步新建沙箱');
  await ui.choose('WAIT_USER'); await ui.click('单步执行');
  assert.equal(ui.phase, 'waitingHuman'); assert(ui.text.includes('复制基线'));
  return source;
}
export async function assertForkUI(ui: DebugUIFixture, source: string) {
  await ui.selectSandbox(source);
  assert.equal(ui.phase, 'waitingAssistance'); assert(ui.text.includes('HELP'));
}
export async function verifyStableGraph(ui: DebugUIFixture) {
  await ui.click('完整状态图');
  const coordinates = () => new Map([...document.querySelectorAll('[aria-label^="查看状态 "]')].map(node => [node.getAttribute('aria-label'), node.getAttribute('transform')]));
  const initial = coordinates(); await ui.sendHelp(); const updated = coordinates();
  assert.deepEqual(updated, initial);
  await ui.click('聚焦所选状态');
  for (const [id, point] of coordinates()) assert.equal(point, initial.get(id));
  assert(ui.text.includes('全局处理')); assert(ui.text.includes('隐藏'));
  await ui.click('转移规则'); await ui.filterRules('all');
  const graph = taskGraph();
  const rows = document.querySelectorAll('.debug-rule-rows button'); assert.equal(rows.length, graph.transitions.length);
  assert(ui.text.includes('retryReviewContinues')); assert(ui.text.includes('空处理'));
  return rows.length;
}
