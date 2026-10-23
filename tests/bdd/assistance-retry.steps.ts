import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { Harness, configuration } from '../helpers.js';
import { SqliteStore, MemoryStore, TeamEngine, WorkRunner, type Intent, type Submission } from '../../src/index.js';
import { WebService } from '../../src/web/service.js';
import type { WebAssistance } from '../../src/web/contracts.js';
import { AssistanceRetry, assistanceRetrySubmission } from '../../web/src/AssistanceRetry.js';
import type { SpecWorld } from './steps.js';

interface State {
  directory: string; store: SqliteStore; original: string; work?: Intent;
  resultId?: string; before: number; goal: unknown; phase?: string;
  calls: Intent[]; command?: Submission; first?: unknown; service?: WebService;
  help?: WebAssistance; html?: string;
}
const states = new WeakMap<SpecWorld, State>();
function s(w: SpecWorld) { const value = states.get(w); assert(value); return value; }
function arrange(w: SpecWorld) {
  assert(w.h.event({ type: 'HELP', requestId: 'H1', caller: 'A', target: 'B', question: '核对恢复能力', expected: '官方依据与限制', requiredTools: ['read'] }).ok);
}
function fail(w: SpecWorld, waiting = true) {
  const work = w.h.claim('assistance'); s(w).work = work;
  assert(w.h.event({ type: 'WORK_FAILED', intentId: work.id, reason: '核查服务中断', transient: false }).ok);
  if (waiting) assert(w.h.event({ type: 'WAIT_USER', question: '请重试核查' }).ok);
}
async function saveAnswer(w: SpecWorld, answer = '本次核查结果：可以恢复') {
  const work = w.h.engine.pending(w.h.room, w.h.task).find(i => i.kind === 'assistance'); assert(work);
  const runner = new WorkRunner(w.h.engine, { execute: async intent => {
    assert.equal(intent.kind, 'assistance'); s(w).calls.push(intent); return { type: 'answer', text: answer };
  } }, () => w.h.now);
  assert(await runner.runOne(w.h.room, w.h.task));
  const result = w.h.context().results.at(-1)!; assert(result); s(w).resultId = result.resultId;
}
function pendingOwner(w: SpecWorld) {
  const pending = w.h.engine.pending(w.h.room, w.h.task);
  assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'owner'); assert.equal(pending[0]!.target, 'A');
  return pending[0]!;
}
Given('原任务由 A 负责并已安排 B 核查', function (this: SpecWorld) {
  const directory = mkdtempSync(join(tmpdir(), 'squad-help-retry-'));
  const store = new SqliteStore(join(directory, 'team.sqlite'));
  this.h = new Harness(configuration(), store);
  states.set(this, { directory, store, original: 'H1', before: 0, calls: [], goal: this.h.context().goal });
  arrange(this);
});
After(async function (this: SpecWorld) {
  const state = states.get(this); if (!state) return;
  if (state.service) await state.service.close();
  state.store.close(); rmSync(state.directory, { recursive: true, force: true });
});
Given('B 的结果处于{string}', async function (this: SpecWorld, timing: string) {
  s(this).phase = timing;
  if (timing === '已保存') await saveAnswer(this);
  else { assert.equal(timing, '执行中'); s(this).work = this.h.claim('assistance'); }
});
When('用户补充资料并完成 B 的结果交接', function (this: SpecWorld) {
  assert(this.h.engine.submit(this.h.room, { id: 'supplement', text: '补充：还需要离线验证' }).ok);
  assert.equal(this.h.view().phase, 'waitingAssistance'); assert.equal(this.h.context().inputs.at(-1)!.applied, false);
  if (s(this).phase === '执行中') {
    const work = s(this).work!;
    assert(this.h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'saved', status: 'success', answer: '本次核查结果：可以恢复', workId: work.id }).ok);
    s(this).resultId = 'saved';
  }
  assert(this.h.engine.flushResults(this.h.room, this.h.task));
});
Then('A 应一次收到核查结果和补充资料且需要评估缺口', function (this: SpecWorld) {
  const work = pendingOwner(this);
  assert.equal(work.payload.resultId, s(this).resultId); assert.equal(work.payload.requiresAssessment, true);
  assert(JSON.stringify(work.payload.inputs).includes('还需要离线验证'));
  assert.equal(this.h.context().messages.filter(m => m.text === '本次核查结果：可以恢复').length, 1);
  assert.equal(this.h.context().intents.filter(i => i.kind === 'owner').length, 2);
});
Then('群内应显示结果已交给 A 的协作提示', function (this: SpecWorld) {
  const notices = this.h.context().messages.filter(m => m.author === 'facilitator' && m.text.includes('核查结果已交给 A'));
  assert.equal(notices.length, 1); assert.equal(notices[0]!.requestId, 'H1');
});
Given('原协助处于{string}', function (this: SpecWorld, interruption: string) {
  if (interruption === '失败待处理') fail(this);
  else if (interruption === '已停止') {
    s(this).work = this.h.claim('assistance'); this.h.event({ type: 'STOP' });
    this.h.event({ type: 'SETTLE', intentId: s(this).work!.id });
    assert.equal(this.h.context().outcome, 'stopped');
  } else {
    assert.equal(interruption, '部分完成');
    this.h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'partial', status: 'partial', answer: '尚缺离线证据' });
    this.h.event({ type: 'WAIT_USER', question: '请补齐核查' });
  }
});
When('用户通过{string}重试 B 的这次协助', function (this: SpecWorld, entry: string) {
  const command: Submission = entry === '明确操作'
    ? { id: 'manual-retry', text: '重试 B 的这次协助', intent: 'retry', replyToTaskId: this.h.task, retryAssistanceId: s(this).original }
    : { id: 'manual-retry', text: entry, ...(entry.startsWith('@') ? { mentions: ['B'] } : {}), ...(this.h.view().phase === 'waitingHuman' ? { intent: 'decision' as const } : {}) };
  s(this).command = command; s(this).before = this.h.context().intents.length;
  this.result = this.h.engine.submit(this.h.room, command);
});
Then('应保留原目标和负责人并用独立请求执行同一核查', function (this: SpecWorld) {
  assert(this.result.ok, this.result.code);
  assert.equal(this.h.context().owner, 'A'); assert.deepEqual(this.h.context().goal, s(this).goal);
  const work = this.h.engine.pending(this.h.room, this.h.task)[0]!;
  assert.equal(work.kind, 'assistance'); assert.equal(work.target, 'B'); assert.equal(work.payload.question, '核对恢复能力');
  assert.equal(work.payload.expected, '官方依据与限制'); assert.deepEqual(work.payload.requiredTools, ['read']);
  assert.notEqual(work.payload.requestId, 'H1');
  assert.equal(this.h.context().assists.at(-1)!.retryOf, 'H1');
  assert.equal(this.h.context().usage.retries, 1); assert.equal(this.h.context().usage.assists, 2);
  assert.equal(Object.keys(s(this).store.read(this.h.room).tasks).length, 1);
});
When('重试的 B 完成核查', async function (this: SpecWorld) {
  await saveAnswer(this); assert(this.h.engine.flushResults(this.h.room, this.h.task));
});
Then('A 应在原任务继续方案且只收到一次本次核查结果', async function (this: SpecWorld) {
  const work = pendingOwner(this); assert.equal(work.payload.resultId, s(this).resultId); assert.equal(work.payload.requiresAssessment, true);
  assert.equal(this.h.context().messages.filter(m => m.text === '本次核查结果：可以恢复').length, 1);
  const runner = new WorkRunner(this.h.engine, { execute: async intent => {
    s(this).calls.push(intent);
    if (intent.kind === 'check') return { type: 'check', passed: true, gaps: [] };
    assert.equal(intent.target, 'A'); assert(JSON.stringify(intent.payload).includes('本次核查结果'));
    return { type: 'deliver', text: 'A 根据 B 的核查完善的最终方案', artifactIds: [] };
  } }, () => this.h.now);
  for (let n = 0; n < 5 && await runner.runOne(this.h.room, this.h.task); n++) { /* bounded drain */ }
  assert.equal(this.h.context().outcome, 'complete'); assert.equal(s(this).calls.filter(i => i.kind === 'owner').length, 1);
  assert.equal(this.h.context().messages.at(-1)!.text, 'A 根据 B 的核查完善的最终方案');
});
Then('应交回已保存结果且不再次调用 B 或消耗重试额度', function (this: SpecWorld) {
  assert(this.result.ok, this.result.code); assert.equal(pendingOwner(this).payload.resultId, s(this).resultId);
  assert.equal(this.h.context().usage.retries, 0); assert.equal(this.h.context().assists.length, 1);
  assert.equal(s(this).calls.filter(i => i.kind === 'assistance').length, 1);
});
When('用户重复提交同一次重试并再次点击旧协助', function (this: SpecWorld) {
  const command: Submission = { id: 'manual-retry', text: 'B 重试', intent: 'retry', replyToTaskId: this.h.task, retryAssistanceId: 'H1' };
  assert(this.h.engine.submit(this.h.room, command).ok);
  assert.equal(this.h.engine.submit(this.h.room, command).duplicate, true);
  assert.equal(this.h.engine.submit(this.h.room, { ...command, id: 'second-click' }).code, 'ASSISTANCE_ALREADY_RETRIED');
});
When('原协助迟到一个结果', function (this: SpecWorld) {
  const work = s(this).work!;
  this.result = this.h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'old-late', status: 'success', answer: '旧尝试迟到', workId: work.id,
    fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
});
Then('应只派发一个新尝试且旧结果不能推进任务', function (this: SpecWorld) {
  assert.equal(this.result.ok, false); assert.equal(this.h.context().assists.length, 2);
  assert.equal(this.h.view().phase, 'waitingAssistance'); assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 1);
  assert(!this.h.context().messages.some(m => m.text === '旧尝试迟到'));
});
Given('重试受到{string}', function (this: SpecWorld, restriction: string) {
  const limits = restriction === '重试额度耗尽' ? { retries: 0 } : restriction === '求助额度耗尽' ? { assists: 1 } : restriction === '续办额度不足' ? { ordinary: 2 } : {};
  this.h = new Harness(configuration(limits)); arrange(this);
  fail(this, !['仍有在途工作', '外部结果未知'].includes(restriction));
  if (restriction === '目标已变更') this.h.event({ type: 'HUMAN_DECISION', text: '更换目标约束' });
  if (restriction === '成员已撤销') this.h.config.bots = this.h.config.bots.filter(b => b.id !== 'B');
  if (restriction === '权限已撤销') this.h.config.bots.find(b => b.id === 'B')!.tools = [];
  if (['仍有在途工作', '外部结果未知'].includes(restriction)) {
    const work = this.h.claim('owner');
    if (restriction === '外部结果未知') this.h.event({ type: 'WORK_FAILED', intentId: work.id, reason: '结果未知', transient: false, resultUncertain: true });
  }
});
Then('应拒绝重试并保留{string}且不新增调用', function (this: SpecWorld, code: string) {
  assert.equal(this.result.ok, false); assert.equal(this.result.code, code);
  assert.equal(this.h.context().intents.length, s(this).before);
});
When('重试结果保存后发生{string}', async function (this: SpecWorld, event: string) {
  await saveAnswer(this);
  if (event === '用户停止') { this.h.event({ type: 'STOP' }); this.h.engine.flushResults(this.h.room, this.h.task); }
  else {
    assert.equal(event, '服务重启');
    s(this).store.close(); s(this).store = new SqliteStore(join(s(this).directory, 'team.sqlite'));
    this.h.engine = new TeamEngine(s(this).store, this.h.config, () => this.h.now);
    this.h.engine.recover(this.h.room); this.h.engine.recover(this.h.room);
  }
});
Then('应达到{string}', function (this: SpecWorld, expected: string) {
  if (expected === '只安排一次 A 续办') {
    assert.equal(pendingOwner(this).payload.resultId, s(this).resultId);
    assert.equal(this.h.context().consumedResults.filter(id => id === s(this).resultId).length, 1);
    assert.equal(this.h.context().messages.filter(m => m.text === '本次核查结果：可以恢复').length, 1);
  } else {
    assert.equal(expected, '保持停止不唤醒 A'); assert.equal(this.h.context().outcome, 'stopped');
    assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 0);
    assert(!this.h.context().messages.some(m => m.text.includes('核查结果已交给')));
  }
});
Given('B 有两项可重试协助', function (this: SpecWorld) {
  fail(this, false); assert(this.h.help('H2').ok); fail(this);
});
Given('B 的核查属于已有其他成员结果的失败评审', function (this: SpecWorld) {
  this.h = new Harness(configuration(), new MemoryStore());
  this.h.engine.submit(this.h.room, { id: 'review', text: '请 B 和 builder-1 评审', mentions: ['B', 'builder-1'] });
  this.h.event({ type: 'COORDINATE', decision: { action: 'review', question: '核对恢复能力', expected: '官方依据与限制', reason: '用户请求' } });
  const b = this.h.claim('assistance'); s(this).original = String(b.payload.requestId);
  this.h.event({ type: 'WORK_FAILED', intentId: b.id, reason: 'B 中断', transient: false });
  const other = this.h.claim('assistance');
  this.h.event({ type: 'RECORD_RESULT', requestId: String(other.payload.requestId), resultId: 'other', status: 'success', answer: '其他成员的意见', workId: other.id });
  this.h.engine.flushResults(this.h.room, this.h.task);
  this.h.event({ type: 'DELIVER', text: '评审暂未完成', artifactIds: [] });
  this.h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'partial-review' });
  assert.equal(this.h.context().outcome, 'partial');
});
Then('应保留其他成员意见并让 A 汇总已修复的评审', function (this: SpecWorld) {
  const work = pendingOwner(this); assert(JSON.stringify(work.payload).includes('其他成员的意见'));
  assert.equal(this.h.context().review!.incomplete, undefined);
  assert.equal(this.h.context().review!.status, 'summarizing');
  assert.deepEqual(new Set(this.h.context().review!.completed), new Set(['B', 'builder-1']));
  assert.equal(s(this).calls.filter(i => i.kind === 'assistance').length, 1);
});
When('网页展示原任务的协助操作', function (this: SpecWorld) {
  // Use the real snapshot projection; the waiting task has no work to dispatch.
  const service = new WebService(this.h.config, join(s(this).directory, 'web.sqlite'));
  s(this).service = service; const room = service.createRoom();
  const at = Date.now();
  const result = service.engine.submit(room.id, { id: 'web-task', text: '原始方案' }); assert(result.taskId);
  service.engine.send(room.id, result.taskId, { type: 'HELP', id: 'help', at, requestId: 'H1', caller: 'A', target: 'B', question: '核查', expected: '证据' });
  const work = service.engine.claim(room.id, result.taskId, service.engine.pending(room.id, result.taskId)[0]!.id)!;
  service.engine.send(room.id, result.taskId, { type: 'WORK_FAILED', id: 'failed', at, intentId: work.id, reason: '核查中断', transient: false });
  service.engine.send(room.id, result.taskId, { type: 'WAIT_USER', id: 'wait', at, question: '等待重试' });
  const help = service.snapshot(room.id).tasks[0]!.assists![0]!; s(this).help = help;
  s(this).html = renderToStaticMarkup(createElement(AssistanceRetry, { help, connected: true, sending: false, onRetry: () => {} }));
});
Then('重试操作应携带原任务和原协助标识', function (this: SpecWorld) {
  const help = s(this).help!; assert(help.retryable); assert(s(this).html!.includes('重试 B 的这次协助')); assert(!s(this).html!.includes('disabled=""'));
  assert.deepEqual(assistanceRetrySubmission(help, 'click'), { id: 'click', text: '重试 B 的这次协助', intent: 'retry', replyToTaskId: help.taskId, retryAssistanceId: 'H1' });
});
Then('不可重试时应禁用操作并说明原因', function (this: SpecWorld) {
  const html = renderToStaticMarkup(createElement(AssistanceRetry, { help: { ...s(this).help!, retryable: false, reason: '重试额度已用尽。' }, connected: true, sending: false, onRetry: () => {} }));
  assert(html.includes('disabled=""')); assert(html.includes('重试额度已用尽。'));
  const offline = renderToStaticMarkup(createElement(AssistanceRetry, { help: s(this).help!, connected: false, sending: false, onRetry: () => {} }));
  assert(offline.includes('disabled=""')); assert(offline.includes('连接恢复后可重试'));
});
When('提交重试相关消息{string}且成员{string}', function (this: SpecWorld, text: string, member: string) {
  if (member === '已撤销') this.h.config.bots = this.h.config.bots.filter(b => b.id !== 'B');
  this.result = this.h.engine.submit(this.h.room, { id: 'language', text, intent: 'decision', replyToTaskId: this.h.task });
});
Then('自然语言路由应为{string}', function (this: SpecWorld, expected: string) {
  if (expected === '普通用户输入') { assert(this.result.ok); assert.equal(pendingOwner(this).target, 'A'); }
  else { assert.equal(this.result.ok, false); assert.equal(this.result.code, expected); }
  assert.equal(this.h.context().assists.length, 1);
});
When('重试命令的事务保存失败', function (this: SpecWorld) {
  s(this).first = this.h.context(); s(this).store.failNextCommit = true;
  assert.throws(() => this.h.engine.submit(this.h.room, { id: 'fail-save', text: 'B 重试' }), /Injected commit failure/);
});
Then('原协助记录应保持不变且不得显示重试成功', function (this: SpecWorld) {
  assert.deepEqual(this.h.context(), s(this).first);
  assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 0);
  assert.throws(() => this.h.engine.submit(this.h.room, { id: 'retry-save', text: 'B 重试' }), /Storage fault/);
});
Given('原任务只剩核查和续办的两次执行额度', function (this: SpecWorld) {
  this.h = new Harness(configuration({ ordinary: 3 })); arrange(this); fail(this);
  assert.equal(this.h.context().config.limits.ordinary - this.h.context().usage.ordinary, 2);
});
When('重试核查尝试额外请求', async function (this: SpecWorld) {
  const runner = new WorkRunner(this.h.engine, { execute: async (_work, _signal, scope) => {
    scope.authorizeAdditionalRequest('extra-request'); assert.fail('保留额度必须在外部请求前拒绝');
  } }, () => this.h.now);
  assert(await runner.runOne(this.h.room, this.h.task));
});
Then('应保留最后一次额度并让 A 处理核查受限的结果', async function (this: SpecWorld) {
  const work = pendingOwner(this);
  assert.equal(work.payload.status, 'failed'); assert(String(work.payload.answer).includes('ASSISTANCE_SYNTHESIS_RESERVED'));
  assert.equal(this.h.context().config.limits.ordinary - this.h.context().usage.ordinary, 1);
  const runner = new WorkRunner(this.h.engine, { execute: async intent => {
    assert.equal(intent.target, 'A'); return { type: 'askUser', question: '核查额度不足，请增加额度或调整要求' };
  } }, () => this.h.now);
  assert(await runner.runOne(this.h.room, this.h.task)); assert.equal(this.h.view().phase, 'waitingHuman');
  assert.equal(this.h.context().usage.ordinary, 3);
});
