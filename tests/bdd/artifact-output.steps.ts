import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { MemoryStore, OpenAICompatibleAdapter, SqliteStore, TeamEngine, WorkRunner, type Intent, type TaskEvent } from '../../src/index.js';
import { Details } from '../../web/src/Details.js';
import { configuration, Harness } from '../helpers.js';
import { artifactSnapshot, delivery, FULL_REPORT, HELPER_REPORT, HELPER_SUMMARY, helperDelivery, RESULT_SUMMARY } from '../artifact-fixture.js';
import type { SpecWorld } from './steps.js';

interface ResultState {
  work?: Intent; event?: TaskEvent; error?: unknown; directory?: string; sqlite?: SqliteStore;
  snapshot?: ReturnType<typeof artifactSnapshot>; html?: string; requests?: { messages: { role: string; content: string }[] }[];
}
const states = new WeakMap<SpecWorld, ResultState>();
function state(world: SpecWorld): ResultState {
  let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value;
}
function claimOwner(world: SpecWorld) { world.h = new Harness(); state(world).work = world.h.claim('owner'); }
function recordHelper(world: SpecWorld) {
  assert(world.h.help().ok); const work = world.h.claim('assistance'); state(world).work = work;
  assert(world.h.engine.send(world.h.room, world.h.task, helperDelivery(world.h, work)).ok);
}
After(function (this: SpecWorld) {
  const s = states.get(this); s?.sqlite?.close();
  if (s?.directory) rmSync(s.directory, { recursive: true, force: true }); states.delete(this);
});

Given('A 已领取一个需要方案的任务', function (this: SpecWorld) { claimOwner(this); });
When('A 提交简短结论及包含来源的完整报告', function (this: SpecWorld) {
  const s = state(this); s.event = delivery(this.h, s.work!); assert(this.h.engine.send(this.h.room, this.h.task, s.event).ok);
});
Then('交付候选与报告应一起持久化并进入完成检查', function (this: SpecWorld) {
  const c = this.h.context(); assert.equal(this.h.view().phase, 'checking'); assert.equal(c.candidate?.text, FULL_REPORT);
  assert.equal(c.artifacts.length, 1); assert.equal(c.artifacts[0]!.content, FULL_REPORT);
  assert(c.candidate?.artifactIds.includes(c.artifacts[0]!.id));
  const check = this.h.engine.pending(this.h.room, this.h.task).find(work => work.kind === 'check'); assert(check);
  assert.equal((check.payload.candidate as { text: string }).text, FULL_REPORT);
});
When('方案通过完成检查', function (this: SpecWorld) {
  assert(this.h.event({ type: 'CHECK_RESULT', resultId: 'checked-report', passed: true, gaps: [] }).ok);
});
Then('群消息应只显示结论并引用真实报告', function (this: SpecWorld) {
  const c = this.h.context(), result = c.messages.find(message => message.kind === 'final'); assert(result);
  assert.equal(result.text, RESULT_SUMMARY); assert(!result.text.includes('独特尾段'));
  assert.deepEqual(result.artifactIds, c.candidate!.artifactIds); assert(result.artifactIds!.every(id => c.artifacts.some(artifact => artifact.id === id)));
});

Given('B 正在为 A 核查方案', function (this: SpecWorld) {
  this.h = new Harness(); assert(this.h.help().ok); state(this).work = this.h.claim('assistance');
});
When('B 提交摘要与完整核查报告', function (this: SpecWorld) {
  assert(this.h.engine.send(this.h.room, this.h.task, helperDelivery(this.h, state(this).work!)).ok);
  assert(this.h.engine.flushResults(this.h.room, this.h.task));
});
Then('B 的消息应简短且报告作者应为 B', function (this: SpecWorld) {
  const c = this.h.context(), answer = c.messages.find(message => message.kind === 'answer' && message.author === 'B'); assert(answer);
  assert.equal(answer.text, HELPER_SUMMARY); assert.equal(c.artifacts[0]?.author, 'B'); assert.equal(c.artifacts[0]?.content, HELPER_REPORT);
  assert(answer.artifactIds?.includes(c.artifacts[0]!.id));
});
Then('A 的接续输入应包含完整核查结果和报告', function (this: SpecWorld) {
  const work = this.h.engine.pending(this.h.room, this.h.task).find(work => work.kind === 'owner'); assert(work);
  assert.equal(work.target, 'A'); assert.equal(work.payload.answer, HELPER_REPORT);
  assert(JSON.stringify(work.payload.artifacts).includes('独特尾段'));
  assert.equal(this.h.context().assists[0]?.answer, HELPER_REPORT);
});

When('保存带报告的结果时事务提交失败', function (this: SpecWorld) {
  (this.h.store as MemoryStore).failNextCommit = true;
  try { this.h.engine.send(this.h.room, this.h.task, delivery(this.h, state(this).work!)); } catch (error) { state(this).error = error; }
});
Then('不应保存报告、交付候选或成功消息', function (this: SpecWorld) {
  assert(state(this).error); const c = this.h.context();
  assert.equal(c.artifacts.length, 0); assert.equal(c.candidate, null); assert(!c.messages.some(message => message.kind === 'final'));
  assert.throws(() => this.h.engine.claim(this.h.room, this.h.task, state(this).work!.id), /Storage fault/);
});
When('相同的带报告结果被重复提交', function (this: SpecWorld) {
  const event = delivery(this.h, state(this).work!);
  assert(this.h.engine.send(this.h.room, this.h.task, event).ok);
  assert(this.h.engine.send(this.h.room, this.h.task, event).duplicate);
});
Then('应只保存一份报告和一份交付候选', function (this: SpecWorld) {
  assert.equal(this.h.context().artifacts.length, 1); assert.equal(this.h.context().candidate?.text, FULL_REPORT);
  assert.equal(this.h.engine.pending(this.h.room, this.h.task).filter(work => work.kind === 'check').length, 1);
});
When('任务发生{string}后旧结果携带报告返回', function (this: SpecWorld, change: string) {
  if (change === '停止') this.h.event({ type: 'STOP' });
  else { assert.equal(change, '目标版本变化'); this.h.event({ type: 'USER_INPUT', text: '更换目标版本', goal: { ...this.h.context().goal, text: '新目标' } }); }
  this.result = this.h.engine.send(this.h.room, this.h.task, delivery(this.h, state(this).work!));
});
Then('旧结果不应创建报告或推进当前任务', function (this: SpecWorld) {
  assert.equal(this.result.ok, false); const c = this.h.context(); assert.equal(c.artifacts.length, 0); assert.equal(c.candidate, null);
  assert(!c.intents.some(work => work.kind === 'check'));
  assert(!c.messages.some(message => message.kind === 'final'));
});

Given('B 的核查摘要和报告已保存但尚未交接', function (this: SpecWorld) {
  const s = state(this); s.directory = mkdtempSync(join(tmpdir(), 'squad-artifacts-'));
  s.sqlite = new SqliteStore(join(s.directory, 'state.sqlite')); this.h = new Harness(configuration(), s.sqlite); recordHelper(this);
  assert.equal(this.h.context().results[0]?.consumed, false);
});
When('执行引擎重新打开并恢复', function (this: SpecWorld) {
  const s = state(this), config = this.h.config; s.sqlite!.close();
  s.sqlite = new SqliteStore(join(s.directory!, 'state.sqlite'));
  this.h = new Harness(config, s.sqlite); this.h.engine.recover(this.h.room); this.h.engine.recover(this.h.room);
});
Then('核查报告与摘要应保留且只安排一次 A 接续', function (this: SpecWorld) {
  const c = this.h.context(); assert.equal(c.artifacts.length, 1); assert.equal(c.artifacts[0]!.content, HELPER_REPORT);
  const answers = c.messages.filter(message => message.author === 'B' && message.kind === 'answer');
  assert.equal(answers.length, 1); assert.equal(answers[0]!.text, HELPER_SUMMARY);
  assert.equal(c.consumedResults.filter(id => id === 'helper-result').length, 1);
  assert.equal(this.h.engine.pending(this.h.room, this.h.task).filter(work => work.kind === 'owner').length, 1);
});

Given('A 已领取一个普通短问答', function (this: SpecWorld) { claimOwner(this); });
When('A 提交一条简短回答', function (this: SpecWorld) {
  const work = state(this).work!;
  assert(this.h.event({ type: 'DELIVER', text: '可以，先使用两个成员。', artifactIds: [], workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } }).ok);
  this.h.event({ type: 'CHECK_RESULT', resultId: 'short-check', passed: true, gaps: [] });
});
Then('应保留直接回复且不生成多余产物', function (this: SpecWorld) {
  assert.equal(this.h.context().artifacts.length, 0); assert.equal(this.h.context().messages.find(message => message.kind === 'final')?.text, '可以，先使用两个成员。');
});
When('A 使用旧协议返回长篇正文且没有报告字段', function (this: SpecWorld) {
  const work = state(this).work!;
  assert(this.h.event({ type: 'DELIVER', text: FULL_REPORT, artifactIds: [], workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } }).ok);
  this.h.event({ type: 'CHECK_RESULT', resultId: 'legacy-check', passed: true, gaps: [] });
});
Then('消息应简短而原文应完整保存在可查看的产物中', function (this: SpecWorld) {
  const c = this.h.context(), message = c.messages.find(message => message.kind === 'final'); assert(message);
  assert(message.text.length <= 300); assert.equal(c.artifacts.length, 1); assert.equal(c.artifacts[0]!.content, FULL_REPORT);
  assert(message.artifactIds?.includes(c.artifacts[0]!.id)); assert.equal(message.detailText, FULL_REPORT);
});

Given('群里有新任务和一条带报告的旧任务消息', function (this: SpecWorld) { state(this).snapshot = artifactSnapshot(); });
When('打开旧消息对应的报告详情', function (this: SpecWorld) {
  const s = state(this); s.html = renderToStaticMarkup(createElement(Details, { snapshot: s.snapshot!, agent: null, connected: true, onClose() {}, target: { taskId: 'old-task', messageId: 'old-result', artifactId: 'old-report' } }));
});
Then('应展示旧任务报告的完整内容并提供下载', function (this: SpecWorld) {
  const html = state(this).html!; assert(html.includes('独特尾段：报告全文必须保留。')); assert(html.includes('下载 恢复方案.md'));
});
Then('不应跳转到新任务的报告', function (this: SpecWorld) { assert(!state(this).html!.includes('不应展示的新任务报告正文')); });
Given('一条简短结果关联报告、来源与工具执行记录', function (this: SpecWorld) { state(this).snapshot = artifactSnapshot(); });
When('打开这条消息的详情', function (this: SpecWorld) {
  const s = state(this); s.html = renderToStaticMarkup(createElement(Details, { snapshot: s.snapshot!, agent: null, connected: true, onClose() {}, target: { taskId: 'old-task', messageId: 'old-result' } }));
});
Then('应能查看完整结果、依据链接和对应任务的执行记录', function (this: SpecWorld) {
  const html = state(this).html!;
  for (const text of ['独特尾段：报告全文必须保留。', 'https://example.com/evidence', '读取官方资料', '版本围栏必须保留']) assert(html.includes(text), text);
  assert(!html.includes('不应展示的新任务报告正文'));
});

Given('本次模型工作需要产出方案', function (this: SpecWorld) {
  const config = configuration(); config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'test' } } };
  this.h = new Harness(config); state(this).requests = [];
});
When('执行支持产物的模型请求', async function (this: SpecWorld) {
  const s = state(this);
  const adapter = new OpenAICompatibleAdapter(this.h.config, { env: {}, clock: () => this.h.now, transport: async (_url, init) => {
    s.requests!.push(JSON.parse(String(init?.body)));
    assert(this.h.context().intents.some(work => work.kind === 'owner' && work.status === 'inflight'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'deliver', text: FULL_REPORT, summary: RESULT_SUMMARY, artifactIds: [], artifacts: [{ name: '恢复方案.md', content: FULL_REPORT }] }) } }] });
  } });
  assert(await new WorkRunner(this.h.engine, adapter, () => this.h.now).runOne(this.h.room, this.h.task));
});
Then('系统提示应要求简短消息并将方案正文写入产物', function (this: SpecWorld) {
  const prompt = state(this).requests![0]!.messages.find(message => message.role === 'system')!.content;
  for (const field of ['summary', 'artifacts', 'name', 'content']) assert(prompt.includes(field));
  assert.match(prompt, /short|concise|brief/i);
});
Then('模型报告应沿用既有预算、领取与结果回传流程', function (this: SpecWorld) {
  assert.equal(state(this).requests!.length, 1); assert.equal(this.h.context().usage.ordinary, 1);
  assert.equal(this.h.context().artifacts.length, 1); assert.equal(this.h.context().candidate?.text, FULL_REPORT);
  assert.equal(this.h.view().phase, 'checking'); assert(this.h.context().intents.some(work => work.kind === 'owner' && work.status === 'done'));
});
