import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { createTeamConfig } from '../../team.config.js';
import { MemoryStore, SqliteStore, resolveModel, type InputIntentSpec, type InputReference, type Intent } from '../../src/index.js';
import { WebService } from '../../src/web/service.js';
import { phaseLabel } from '../../web/src/ui.js';
import { buildDetailDocument } from '../../web/src/detail-document.js';
import { complexInput, InputIntentFixture, intentConfig, parsedIntent } from '../input-intent-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

interface IntentState {
  f: InputIntentFixture; command?: string; expected?: string; kind?: Intent['kind']; stage?: string;
  refs?: InputReference[]; old?: Intent; baseline?: string; usage?: number; failure?: unknown;
  web?: WebService; directory?: string; room?: string;
}
const states = new WeakMap<SpecWorld, IntentState>();
const state = (w: SpecWorld) => { const s = states.get(w); assert(s); return s; };
function setup(w: SpecWorld, config = intentConfig(), sqlite = false) {
  const s: IntentState = { f: new InputIntentFixture(config, sqlite) }; states.set(w, s); return s.f;
}
After(async function(this: SpecWorld) {
  const s = states.get(this); if (!s) return;
  await s.web?.close(); s.f.close(); if (s.directory) rmSync(s.directory, { recursive: true, force: true }); states.delete(this);
});

Given('已配置模型且准备处理意图指令{string}', function(this: SpecWorld, command: string) {
  const f = setup(this); state(this).command = command === '等待回复时停止' ? '停止' : command === '等待回复时继续' ? '继续' : command;
  if (command.startsWith('@')) return;
  assert(f.submit('写一份计划').ok);
  if (command.startsWith('等待回复时')) { f.event({ type: 'WAIT_USER', question: '请提供必要材料' }); state(this).stage = 'decision'; }
  if (command === '继续') assert(f.event({ type: 'STOP' }).ok);
  if (command === 'B 重试') {
    f.prepare('assistance'); const work = f.context().intents.find(i => i.kind === 'assistance')!;
    assert(f.event({ type: 'WORK_FAILED', intentId: work.id, reason: '受控失败', transient: false }).ok);
  }
});
When('用户提交该意图指令', function(this: SpecWorld) { const s = state(this); assert(s.f.submit(s.command!, { id: 'control-input', ...(s.stage === 'decision' ? { intent: 'decision' as const } : {}) }).ok); });
Then('应按{string}处理且不创建模型解析工作', function(this: SpecWorld, behavior: string) {
  const f = state(this).f, c = f.context();
  assert(!c.intents.some(i => i.kind === 'interpretation')); assert.equal(f.requests.length, 0);
  if (behavior === '点名负责人') assert.equal(c.owner, 'B');
  if (behavior === '停止当前任务') assert(c.stopped);
  if (behavior === '明确继续原任务') { assert.equal(c.epoch, 2); assert.equal(c.outcome, null); }
  if (behavior === '重试原协助') { assert.equal(c.assists.length, 2); assert.equal(c.assists[1]!.retryOf, c.assists[0]!.id); }
});
Then('明确控制消息应保留原文和回执', function(this: SpecWorld) {
  const s = state(this); assert(s.f.context().messages.some(message => message.kind === 'user' && message.text === s.command));
  assert(s.f.store.transact(s.f.room, tx => tx.receipt('control-input')));
});

Given('用户提交包含目标约束和交付要求的复杂输入', function(this: SpecWorld) { assert(setup(this).submit().ok); });
Then('解析前应只保存原始消息和待领取的解析工作', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'interpreting'); assert.equal(f.requests.length, 0);
  assert.equal(f.context().messages[0]!.text, complexInput); assert.equal(f.context().inputAnalyses?.[0]?.rawText, complexInput);
  assert.deepEqual(f.engine.pending(f.room, f.task).map(i => i.kind), ['interpretation']); assert.equal(f.work.status, 'pending');
});
When('执行合法意图解析', async function(this: SpecWorld) { await state(this).f.run(); });
Then('应保存结构化目标约束交付要求和解析回执再安排负责人', function(this: SpecWorld) {
  const f = state(this).f, c = f.context(); assert.equal(f.view().phase, 'running');
  assert.deepEqual(c.inputAnalyses?.[0]?.spec, parsedIntent()); assert.equal(c.inputAnalyses?.[0]?.status, 'resolved');
  assert.equal(f.work.status, 'done'); assert.equal(c.trace.filter(t => t.event === 'INTERPRETATION_RESULT').length, 1);
  const pending = f.engine.pending(f.room, f.task); assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'owner');
  assert.deepEqual(pending[0]!.payload.inputIntents, c.inputAnalyses);
});
Then('解析应消耗一次普通额度', function(this: SpecWorld) { const f = state(this).f; assert.equal(f.context().usage.ordinary, 1); assert.equal(f.context().usage.checks, 0); assert.equal(f.work.requestCount, 1); });

Given('复杂输入已解析且准备启动{string}', async function(this: SpecWorld, kind: string) {
  const f = setup(this); await f.parse(); state(this).kind = kind as Intent['kind']; f.prepare(kind as Intent['kind']);
});
When('执行该角色并捕获模型请求', async function(this: SpecWorld) { await state(this).f.run(); });
Then('模型上下文应同时包含原始输入和相同的校验后意图', function(this: SpecWorld) {
  const s = state(this), request = s.f.requests.at(-1)!; assert.equal(request.kind, s.kind);
  assert.deepEqual(request.context.inputIntents, s.f.context().inputAnalyses);
  assert(JSON.stringify(request.context.messages).includes(complexInput));
  assert(request.messages[0]!.content.includes('Interpretations supplement the original goal'));
  if (s.kind === 'assistance') { assert.equal(request.context.question, '核对恢复风险'); assert.equal(request.context.expected, '出处与限制'); }
});

Given('意图模型返回{string}且无格式修正额度', function(this: SpecWorld, reference: string) {
  const f = setup(this, intentConfig({ retries: 0 }));
  assert(f.submit('历史方案', { id: 'history' }).ok); const oldTask = f.task;
  assert(f.event({ type: 'ARTIFACT', artifact: { id: 'historical-plan', name: 'plan.md', content: '先验证恢复再发布。' } }).ok);
  f.prepare('check'); assert(f.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'old-check' }).ok);
  assert(f.submit().ok); const refs = f.work.payload.references as InputReference[];
  const real = refs.filter(ref => ref.taskId === oldTask && ['message', 'artifact'].includes(ref.kind)); assert(real.length >= 2);
  state(this).refs = real;
  f.replies = [{ type: 'interpretation', spec: parsedIntent('request', { references: reference === '真实历史消息和产物' ? real
    : reference === '不存在的产物' ? [{ kind: 'artifact', id: 'invented', taskId: oldTask }]
    : [{ ...real[0]!, taskId: f.task }] }) }];
});
When('执行该引用的意图解析', async function(this: SpecWorld) { await state(this).f.run(); });
Then('引用应被{string}且不把历史产物变成本轮交付', function(this: SpecWorld, verdict: string) {
  const s = state(this), c = s.f.context(); assert.equal(c.artifacts.length, 0);
  if (verdict === '接受') { assert.equal(s.f.view().phase, 'running'); assert.deepEqual(c.inputAnalyses?.[0]?.spec?.references, s.refs); }
  else { assert.equal(s.f.view().phase, 'waitingHuman'); assert.equal(c.inputAnalyses?.[0]?.status, 'failed'); assert(!c.inputAnalyses?.[0]?.spec); }
});

Given('意图模型认为指代不足并返回具体澄清问题', function(this: SpecWorld) {
  const f = setup(this); assert(f.submit('修改上面那个方案，保留公开来源').ok);
  f.replies = [{ type: 'interpretation', spec: parsedIntent('request', { confidence: 0.4, clarification: '你指的是成本方案还是恢复方案？' }) }];
});
When('执行该歧义输入的解析', async function(this: SpecWorld) { await state(this).f.run(); });
Then('应等待用户且不得启动规划或其他成员', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'waitingHuman'); assert.equal(f.engine.pending(f.room, f.task).length, 0);
  assert.equal(f.context().inputAnalyses?.[0]?.status, 'clarification'); assert(f.context().reason.includes('成本方案')); assert.equal(f.requests.length, 1);
});
When('用户补充明确的引用并完成解析', async function(this: SpecWorld) {
  const f = state(this).f; assert(f.submit('采用成本方案，仍然只用公开资料', { id: 'clarify', intent: 'decision', replyToTaskId: f.task }).ok);
  assert.equal(f.view().phase, 'interpreting'); await f.run();
});
Then('应携带原始约束和澄清结果继续原任务', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'running'); assert.equal(f.context().inputAnalyses?.length, 2);
  assert(f.context().goal.constraints.some(c => c.includes('公开资料')));
  assert.equal(f.engine.pending(f.room, f.task)[0]?.kind, 'owner'); assert.equal(f.requests.filter(r => r.kind === 'interpretation').length, 2);
});

Given('意图服务依次返回{string}和合法意图', function(this: SpecWorld, failure: string) {
  const f = setup(this); assert(f.submit().ok); state(this).expected = failure;
  const bad = { type: 'interpretation', spec: { objective: '遗漏必要字段' } };
  if (failure === '持续Schema错误') f.response = () => modelResponse(bad);
  else f.replies = [failure === 'Schema错误' ? bad : new Response('private-provider-body', { status: failure === 'HTTP503' ? 503 : 401 })];
});
When('执行意图故障恢复流程', async function(this: SpecWorld) {
  const s = state(this); await s.f.run(); if (s.expected === 'HTTP503') await s.f.run();
});
Then('应按{string}结算且不应用无效解析', function(this: SpecWorld, outcome: string) {
  const f = state(this).f, success = ['格式修正成功', '有限重试成功'].includes(outcome);
  assert.equal(f.view().phase, success ? 'running' : 'waitingHuman'); assert.equal(f.requests.length, outcome === '等待用户' ? 1 : 2);
  assert.equal(f.context().trace.filter(t => t.event === 'INPUT_INTERPRETED').length, success ? 1 : 0);
  assert.equal(f.context().usage.retries, outcome === '等待用户' ? 0 : 1);
  assert(!JSON.stringify(f.store.read(f.room)).includes('private-provider-body'));
});
Given('复杂输入的普通执行额度为0', function(this: SpecWorld) { assert(setup(this, intentConfig({ ordinary: 0 })).submit().ok); });
When('尝试运行意图解析', async function(this: SpecWorld) { await state(this).f.run(); });
Then('不应调用模型且应保留额度耗尽原因', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.requests.length, 0); assert.equal(f.view().phase, 'ended'); assert.equal(f.context().outcome, 'failed'); assert(f.context().reason.includes('budget exhausted'));
});

Given('解析工作已领取后发生{string}', function(this: SpecWorld, change: string) {
  const f = setup(this); assert(f.submit().ok); const old = f.claim(); state(this).old = old;
  if (change === '用户停止' || change === '开始新轮次') assert(f.event({ type: 'STOP' }).ok);
  if (change === '开始新轮次') { assert(f.event({ type: 'SETTLE', intentId: old.id }).ok); assert(f.event({ type: 'CONTINUE' }).ok); }
  if (change === '目标版本更新') assert(f.event({ type: 'USER_INPUT', text: '必须改成新目标', goal: { text: '新目标', constraints: ['新约束'], criteria: [], requiredArtifacts: 0 } }).ok);
  if (change === '工作超时') { f.now = old.deadline!; f.engine.tick(f.room); }
});
When('旧解析结果尝试提交', function(this: SpecWorld) { const s = state(this); assert.equal(s.f.result(s.old!).ok, false); });
Then('不得使用该结果启动任何成员', function(this: SpecWorld) {
  const f = state(this).f; assert(!f.context().inputAnalyses?.some(i => i.status === 'resolved')); assert.equal(f.context().outcome === 'complete', false);
  assert(f.engine.pending(f.room, f.task).every(i => ['interpretation', 'cancel'].includes(i.kind)));
});

Given('{string}保存了{string}的意图解析', async function(this: SpecWorld, storage: string, stage: string) {
  const f = setup(this, intentConfig(), storage === 'SQLite'); assert(f.submit().ok); state(this).stage = stage;
  if (stage === '执行中') f.claim(); if (stage === '已解析') await f.run();
  state(this).usage = f.context().usage.ordinary; state(this).baseline = JSON.stringify(f.context().inputAnalyses);
});
When('重新打开存储并恢复意图任务', function(this: SpecWorld) { state(this).f.reopen(); });
Then('应保留输入解析和已用额度并仅接续未完成工作', async function(this: SpecWorld) {
  const s = state(this), f = s.f; assert.equal(f.context().usage.ordinary, s.usage); assert.equal(f.context().inputAnalyses?.[0]?.rawText, complexInput);
  if (s.stage === '已解析') { assert.equal(JSON.stringify(f.context().inputAnalyses), s.baseline); assert.equal(f.engine.pending(f.room, f.task)[0]?.kind, 'owner'); assert.equal(f.requests.length, 1); }
  else { assert.equal(f.engine.pending(f.room, f.task)[0]?.kind, 'interpretation'); await f.run(); assert.equal(f.requests.length, 1); assert.equal(f.context().usage.ordinary, s.usage! + 1); }
});

Given('{string}将在意图{string}时提交失败', function(this: SpecWorld, storage: string, stage: string) {
  const f = setup(this, intentConfig(), storage === 'SQLite'); state(this).stage = stage;
  if (stage === '结果') { assert(f.submit().ok); state(this).old = f.claim(); }
  state(this).baseline = JSON.stringify(f.store.read(f.room)); (f.store as MemoryStore | SqliteStore).failNextCommit = true;
});
When('尝试保存该意图事务', function(this: SpecWorld) {
  const s = state(this); try { if (s.stage === '输入') s.f.submit(); else s.f.result(s.old!); } catch (e) { s.failure = e; }
});
Then('消息解析结果后继工作和回执应共同回滚且禁止继续调用', function(this: SpecWorld) {
  const s = state(this); assert(s.failure instanceof Error); assert.equal(JSON.stringify(s.f.store.read(s.f.room)), s.baseline); assert.equal(s.f.requests.length, 0);
  assert.throws(() => s.f.engine.submit('another-room', { id: 'after-failure', text: '请求' }), /Storage fault/);
  const receipt = s.f.store.transact(s.f.room, tx => tx.receipt(s.stage === '输入' ? 'input-1' : `result:${s.old!.id}`)); assert.equal(receipt, undefined);
});

Given('{string}正在执行且用户提交新的复杂约束', async function(this: SpecWorld, kind: string) {
  const f = setup(this); await f.parse(); f.prepare(kind as Intent['kind']); const work = f.engine.pending(f.room, f.task)[0]!;
  state(this).old = f.engine.claim(f.room, f.task, work.id)!;
  assert(f.submit('必须保留所有原有出处；增加失败恢复步骤；同时给出验收清单', { id: 'supplement' }).ok);
});
Then('不应并行运行解析工作或让旧检查发布最终结果', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.requests.length, 1); assert.equal(f.engine.pending(f.room, f.task).length, 0); assert.equal(f.context().outcome, null);
});
When('原工作结算并解析这次补充', async function(this: SpecWorld) {
  const s = state(this), f = s.f, work = s.old!;
  if (work.kind === 'check') assert(f.event({ type: 'CHECK_RESULT', workId: work.id, resultId: 'old-check-result', passed: true, gaps: [] }).ok);
  else if (work.kind === 'facilitator') assert(f.event({ type: 'COORDINATE', workId: work.id, decision: { action: 'continue', reason: '继续原工作' } }).ok);
  else if (work.kind === 'assistance') {
    assert(f.event({ type: 'RECORD_RESULT', workId: work.id, requestId: 'intent-help', resultId: 'old-help-result', answer: '已有协助结果', status: 'success' }).ok);
    assert(f.engine.flushResults(f.room, f.task));
  } else assert(f.event({ type: 'DELIVER', workId: work.id, text: '旧目标结果', artifactIds: [] }).ok);
  assert.equal(f.view().phase, 'interpreting'); assert(f.engine.pending(f.room, f.task).every(i => i.kind === 'interpretation'));
  await f.run();
  if (f.view().phase === 'coordinating') await f.run();
});
Then('后继负责人应同时收到两次输入的意图和完整约束', function(this: SpecWorld) {
  const f = state(this).f, next = f.engine.pending(f.room, f.task)[0]!; assert.equal(next.kind, 'owner'); assert.equal(f.context().inputAnalyses?.length, 2);
  assert.deepEqual(next.payload.inputIntents, f.context().inputAnalyses); assert(JSON.stringify(next.payload.messages).includes('增加失败恢复步骤'));
  assert.equal(f.context().outcome, null); assert.equal(f.requests.filter(r => r.kind === 'interpretation').length, 2);
});

Given('已领取的解析工作直接提交包含伪造引用的结果', function(this: SpecWorld) {
  const f = setup(this); assert(f.submit().ok); const work = f.claim();
  const spec = parsedIntent('request', { references: [{ kind: 'artifact', id: 'invented', taskId: f.task }] });
  assert.equal(f.result(work, spec).code, 'INVALID_INPUT_INTENT');
});
Then('状态机应拒绝该结果并等待用户且保留失败原因', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'waitingHuman'); assert.equal(f.context().inputAnalyses?.[0]?.status, 'failed');
  assert(f.context().reason.includes('INVALID_INPUT_INTENT')); assert.equal(f.engine.pending(f.room, f.task).length, 0); assert.equal(f.work.status, 'done');
});
Given('意图解析尚未解决而用户明确继续任务', async function(this: SpecWorld) {
  const f = setup(this); assert(f.submit().ok); f.replies = [{ type: 'interpretation', spec: parsedIntent('request', { clarification: '需要指定方案', confidence: 0.3 }) }];
  await f.run(); assert.equal(f.view().phase, 'waitingHuman'); assert(f.event({ type: 'CONTINUE' }).ok);
});
Then('应先创建新的解析工作而不能直接开始负责人工作', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'interpreting'); assert.equal(f.context().epoch, 2);
  assert.deepEqual(f.engine.pending(f.room, f.task).map(i => i.kind), ['interpretation']); assert.equal(f.context().usage.ordinary, 1);
});
Given('第一条解析正在执行时又收到第二条复杂输入', function(this: SpecWorld) {
  const f = setup(this); assert(f.submit().ok); state(this).old = f.claim();
  assert(f.submit('必须同时提供另一份验收报告', { id: 'second-complex' }).ok); assert.equal(f.engine.pending(f.room, f.task).length, 0);
});
When('第一条解析正常返回', function(this: SpecWorld) { const s = state(this); assert(s.f.result(s.old!).ok); });
Then('应先解析第二条输入再把完整意图交给负责人', async function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'interpreting'); assert.deepEqual(f.engine.pending(f.room, f.task).map(i => i.kind), ['interpretation']);
  await f.run(); assert.equal(f.view().phase, 'running'); const next = f.engine.pending(f.room, f.task)[0]!;
  assert.equal(next.kind, 'owner'); assert.equal((next.payload.inputIntents as unknown[]).length, 2); assert.equal(f.context().inputAnalyses?.filter(i => i.status === 'resolved').length, 2);
});

Given('已解析任务的检查执行中收到一条规则即可理解的补充', async function(this: SpecWorld) {
  const f = setup(this); await f.parse(); f.prepare('check');
  const work = f.engine.pending(f.room, f.task)[0]!; state(this).old = f.engine.claim(f.room, f.task, work.id)!;
  assert(f.submit('补充一段结论', { id: 'simple-supplement' }).ok);
  assert.equal(f.context().inputAnalyses!.at(-1)!.source, 'rule');
});
When('原检查返回通过', function(this: SpecWorld) {
  const s = state(this); assert(s.f.event({ type: 'CHECK_RESULT', workId: s.old!.id, resultId: 'old-check', passed: true, gaps: [] }).ok);
});
Then('应先把补充交给负责人而不能直接发布完成', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.context().outcome, null); assert.equal(f.view().phase, 'running');
  const next = f.engine.pending(f.room, f.task)[0]!; assert.equal(next.kind, 'owner');
  assert(JSON.stringify(next.payload.inputIntents).includes('补充一段结论'));
});

Given('意图模型尝试返回{string}且没有格式修正额度', function(this: SpecWorld, attempt: string) {
  const f = setup(this, intentConfig({ retries: 0 })); assert(f.submit().ok);
  const spec: Record<string, unknown> = { ...parsedIntent() };
  if (attempt === '新负责人字段') spec.owner = 'B';
  else if (attempt === '低置信度却不澄清') spec.confidence = 0.2;
  else spec.action = attempt === 'stop动作' ? 'stop' : 'review';
  f.replies = [{ type: 'interpretation', spec }];
});
When('执行该越权意图解析', async function(this: SpecWorld) { await state(this).f.run(); });
Then('应拒绝越权结果并保持原负责人和控制状态', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.view().phase, 'waitingHuman'); assert.equal(f.context().owner, 'A'); assert.equal(f.context().stopped, false);
  assert.equal(f.context().review, undefined); assert(!f.context().inputAnalyses?.[0]?.spec); assert.equal(f.engine.pending(f.room, f.task).length, 0);
});

Given('同一复杂输入和合法解析结果各被提交两次', function(this: SpecWorld) {
  const f = setup(this); assert(f.submit().ok); assert(f.submit().duplicate); const work = f.claim(); assert(f.result(work).ok); assert(f.result(work).duplicate);
});
Then('应只保存一份输入和解析并安排一次负责人工作', function(this: SpecWorld) {
  const f = state(this).f; assert.equal(f.context().inputAnalyses?.length, 1); assert.equal(f.context().messages.filter(m => m.kind === 'user').length, 1);
  assert.equal(f.context().intents.filter(i => i.kind === 'owner' && i.status === 'pending').length, 1); assert.equal(f.context().usage.ordinary, 1);
});
Then('同一输入身份携带不同文本应被拒绝', function(this: SpecWorld) { assert.equal(state(this).f.submit('不同文本').code, 'REQUEST_ID_CONFLICT'); });

Given('用户输入包含{string}', function(this: SpecWorld, content: string) {
  const f = setup(this); assert(f.submit('写计划').ok); f.prepare('assistance'); const work = f.context().intents.find(i => i.kind === 'assistance')!;
  assert(f.event({ type: 'WORK_FAILED', intentId: work.id, transient: false, reason: '原协助失败' }).ok);
  const command = ({ 引用中的停止: '> 停止', 代码中的继续: '```text\n继续\n```', 否定的重试: '不要 B 重试', 普通句子中的停止: '解释停止机制的原理' })[content];
  assert(command); state(this).command = command;
});
When('提交含引用命令的消息', function(this: SpecWorld) { const s = state(this); assert(s.f.submit(s.command!, { id: 'quoted' }).ok); });
Then('不应停止继续重试或扩大评审范围', function(this: SpecWorld) {
  const c = state(this).f.context(); assert.equal(c.stopped, false); assert.equal(c.epoch, 1); assert.equal(c.assists.length, 1); assert.equal(c.review, undefined);
});

Given('配置了独立意图模型或关闭深度解析并持有旧版快照', function(this: SpecWorld) { setup(this); });
Then('意图模型应遵守配置继承密钥隔离和恢复绑定', function(this: SpecWorld) {
  const defaults = { MODEL_BASE_URL: 'https://default.example/v1', MODEL_NAME: 'base', MODEL_API_KEY: 'secret', FACILITATOR_MODEL_NAME: 'coordinator' };
  const inherited = createTeamConfig(defaults); assert.equal(resolveModel(inherited, 'interpretation', 'facilitator')?.service.model, 'coordinator');
  const independent = createTeamConfig({ ...defaults, INTENT_MODEL_NAME: 'parser', INTENT_MODEL_BASE_URL: 'https://parse.example/v1' });
  assert.equal(resolveModel(independent, 'interpretation', 'facilitator')?.service.apiKeyEnv, 'INTENT_MODEL_API_KEY');
  assert(!JSON.stringify(independent).includes('secret'));
  const f = state(this).f; assert(f.submit().ok); const changed = structuredClone(f.config); changed.models!.services.test!.model = 'changed';
  f.reopen(changed); assert.equal(f.view().phase, 'waitingHuman'); assert.equal(f.context().reason, 'Model configuration changed'); assert.equal(f.engine.pending(f.room, f.task).length, 0);
});
Then('关闭深度解析或读取旧快照仍能执行既有流程', function(this: SpecWorld) {
  const config = intentConfig(); config.inputAnalysis = { enabled: false }; const disabled = new InputIntentFixture(config);
  try { assert(disabled.submit().ok); assert.equal(disabled.view().phase, 'running'); assert.equal(disabled.context().inputAnalyses?.[0]?.source, 'rule'); }
  finally { disabled.close(); }
  const legacy = new InputIntentFixture();
  try {
    assert(legacy.submit('旧版任务', { id: 'legacy' }).ok);
    legacy.store.transact(legacy.room, tx => { const stored = tx.room.tasks[legacy.task] as { snapshot: { context: { inputAnalyses?: unknown } } }; delete stored.snapshot.context.inputAnalyses; });
    legacy.reopen(); assert.equal(legacy.view().phase, 'running'); assert.equal(legacy.engine.pending(legacy.room, legacy.task)[0]?.kind, 'owner');
  } finally { legacy.close(); }
});

Given('网页收到复杂输入并使用受控意图服务', function(this: SpecWorld) {
  const f = setup(this), s = state(this); s.directory = mkdtempSync(join(tmpdir(), 'squad-intent-web-'));
  s.web = new WebService(f.config, join(s.directory, 'team.sqlite'), f.adapter); s.room = s.web.createRoom().id;
});
When('网页执行器完成解析及交付', async function(this: SpecWorld) {
  const s = state(this); s.web!.submit(s.room!, { id: 'web-input', text: complexInput });
  const initial = s.web!.snapshot(s.room!); assert.equal(initial.tasks[0]?.phase, 'interpreting'); assert.equal(phaseLabel(initial.tasks[0]), '正在理解输入');
  for (let i = 0; i < 100; i++) { if (s.web!.snapshot(s.room!).tasks[0]?.phase === 'ended') return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('网页意图解析未在有限时间内结算');
});
Then('快照应包含原始输入意图状态和解析调用记录', function(this: SpecWorld) {
  const s = state(this), snapshot = s.web!.snapshot(s.room!); assert.equal(snapshot.tasks[0]?.outcome, 'complete');
  assert.equal(snapshot.tasks[0]?.inputAnalyses?.[0]?.rawText, complexInput); assert.equal(snapshot.tasks[0]?.inputAnalyses?.[0]?.status, 'resolved');
  assert(snapshot.events.some(e => e.title === '开始理解输入')); assert(snapshot.events.some(e => e.title === '输入理解完成'));
  assert.equal(snapshot.works.filter(w => w.kind === 'interpretation').length, 1);
  const exported = buildDetailDocument(snapshot, { target: { taskId: snapshot.tasks[0]!.id } }); assert(exported?.content.includes(complexInput)); assert(exported?.content.includes('expectedOutputs'));
});

Given('用户直接指定目标硬约束且解析模型遗漏它们', async function(this: SpecWorld) {
  const f = setup(this); assert(f.submit(complexInput, { goal: { text: '必须交付可下载报告', constraints: ['不得改用私有资料'], criteria: ['包含恢复风险'], requiredArtifacts: 1 } }).ok);
  f.replies = [{ type: 'interpretation', spec: parsedIntent('request', { constraints: [], expectedOutputs: [], acceptanceCriteria: [] }) }]; await f.run();
});
When('解析完成并进行交付检查', async function(this: SpecWorld) { const f = state(this).f; f.prepare('check'); await f.run(); });
Then('全部角色仍应收到原始目标硬约束并据此检查交付', function(this: SpecWorld) {
  const f = state(this).f, request = f.requests.at(-1)!; assert.equal(request.kind, 'check');
  assert.deepEqual(request.context.goal, f.context().goal); assert(JSON.stringify(request.context.goal).includes('不得改用私有资料'));
  assert.equal(f.context().goal.requiredArtifacts, 1); assert.notEqual(f.context().outcome, 'complete'); assert.equal(f.view().phase, 'coordinating');
});
