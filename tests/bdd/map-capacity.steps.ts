import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { InputIntentSpec, TaskContext, TaskInput } from '../../src/types.js';
import { persistTask, restoreTask } from '../../src/task.machine.js';
import type { SpecWorld } from './steps.js';
import { documentRequest, groupedIntent, MapCapacityFixture, prepareCapacitySnapshot, prepareDispatchDecrease, prepareLegacyCapacity, prepareLegacyPendingCapacity, prepareRetriedCapacitySnapshot } from '../map-capacity-fixture.js';
import { CapacityModel, capacityModelIntent } from '../map-capacity-model-fixture.js';
import { CapacityAdapterScenario } from '../map-capacity-adapter-fixture.js';
interface State { fixture?: MapCapacityFixture; model?: CapacityModel; protocol?: CapacityAdapterScenario; variant?: string; spec?: InputIntentSpec;
  preparedModelCap?: unknown; preparedEngineCap?: unknown; beforeUsage?: TaskContext['usage']; beforeModelUsage?: TaskContext['usage']; dispatch?: TaskContext;
  duplicate?: boolean; unchangedCount?: boolean; firstDone?: boolean; recoveredPending?: number; originalReads?: string[]; replayedReads?: string[] }
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) { let current = states.get(world); if (!current) { current = {}; states.set(world, current); } return current; }
function fixture(world: SpecWorld) { const value = state(world).fixture; assert(value); return value; }
function model(world: SpecWorld) { const value = state(world).model; assert(value); return value; }
function interpret(value: CapacityModel, spec = capacityModelIntent()) { value.claim(); value.consume(); assert(value.interpret(spec).ok); }
After(async function (this: SpecWorld) { const value = states.get(this)?.fixture; if (value) { value.releaseMaps(); await value.parallel; value.close(); } states.delete(this); });
Given('用户要求汇总八份独立文档且有四名可用非负责人成员', function (this: SpecWorld) { state(this).model = new CapacityModel(); state(this).preparedModelCap = model(this).work.payload.maxPartitions; state(this).fixture = new MapCapacityFixture(); });
When('输入理解按已扣本次请求额度的容量规划分片', async function (this: SpecWorld) { interpret(model(this)); assert(fixture(this).submit(documentRequest).ok); state(this).preparedEngineCap = fixture(this).work.payload.maxPartitions; assert(await fixture(this).run()); });
Then('理解请求应看到最大分片数八且首次计划完整覆盖八份文档各一次', function (this: SpecWorld) {
  const value = model(this); assert.equal(state(this).preparedModelCap, 8); assert.equal(state(this).preparedEngineCap, 8); assert.equal(value.work.payload.maxPartitions, 8); assert.equal(value.context.usage.ordinary, 1);
  assert.deepEqual(value.pending('assistance').map(work => work.payload.partition), capacityModelIntent().decomposition!.partitions);
  assert.equal(value.context.discussion!.mapReduce!.synthesis, capacityModelIntent().decomposition!.synthesis);
  assert.deepEqual((value.pending('assistance')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, capacityModelIntent()); assert.equal(value.pending('owner').length, 0);
  fixture(this).assertPlan(); assert.equal(fixture(this).requests.filter(request => request.kind === 'interpretation').length, 1);
});
Then('理解提示应说明宿主容量和多文档分组', function (this: SpecWorld) {
  const prompt = fixture(this).requests[0]!.messages[0]!.content;
  assert(prompt.includes('context.maxPartitions')); assert(prompt.includes('multiple documents'));
});
When('所有分片结算并归并后交回负责人', async function (this: SpecWorld) {
  const value = model(this); value.settleGroups(); assert.equal(value.pending('discussionSummary').length, 1); const summary = value.pending('discussionSummary')[0]!;
  assert(value.send({ type: 'CLAIM', intentId: summary.id }).ok); const work = value.context.intents.find(item => item.id === summary.id)!;
  assert(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, text: '归并所有八份文档的证据与来源', status: 'success' }).ok);
  await fixture(this).beginParallel(); await fixture(this).finish();
});
Then('应只归并一次并保留八份文档的原始要求与来源', function (this: SpecWorld) { const m = model(this), value = fixture(this); assert.equal(m.pending('owner').length, 1); assert.deepEqual((m.pending('owner')[0]!.payload.discussion as { results: { target: string }[] }).results.map(result => result.target), ['B', 'C', 'D', 'E']); assert.equal(value.context().outcome, 'complete'); assert.equal(value.requests.filter(request => request.kind === 'discussionSummary').length, 1); assert.equal(value.documentReads.length, 8); });
Given('分片容量受到{string}约束', function (this: SpecWorld, limit: string) {
  const value = new CapacityModel(input => {
    if (limit === '剩余两次协助') input.config.limits.assists = 2;
    else if (limit === '普通额度只够三片及归并续办') input.config.limits.ordinary = 6;
    else if (limit === '本次理解后只够一片') input.config.limits.ordinary = 4;
    else if (limit === '本次理解后不足一片') input.config.limits.ordinary = 2;
    else if (limit === '资源充足仍受协议上限约束') input.config.bots.push(...['F', 'G', 'H', 'I', 'J', 'K'].map(id => ({ id, name: id, instructions: '', tools: [] })));
  });
  if (limit === '仅三名空闲成员') value.busyMember(); const s = state(this); s.model = value; s.fixture = prepareCapacitySnapshot(limit); s.variant = limit; s.preparedModelCap = value.work.payload.maxPartitions; s.preparedEngineCap = s.fixture.work.payload.maxPartitions;
});
When('为本次输入理解准备已计费的容量快照', async function (this: SpecWorld) { model(this).claim(); model(this).consume(); assert.equal(await fixture(this).run(), true); });
Then('最大分片数应为{int}且不改变调度权限', function (this: SpecWorld, expected: number) {
  const s = state(this), m = model(this), f = fixture(this); if (s.variant !== '仅三名空闲成员') { assert.equal(s.preparedModelCap, expected); assert.equal(s.preparedEngineCap, expected); }
  assert.equal(m.work.payload.maxPartitions, expected); assert.equal(m.context.usage.ordinary, 1); assert.equal(m.context.usage.assists, 0);
  f.assertCapacity(expected); assert.equal(f.beforeProviderUsage[0]!.ordinary, 1); assert.equal(f.beforeProviderUsage[0]!.assists, 0);
});
Given('本次理解的最大分片数为{int}', function (this: SpecWorld, expected: number) { assert(expected === 0 || expected === 1); const s = state(this); s.fixture = new MapCapacityFixture(expected); s.model = new CapacityModel(input => { input.config.limits.ordinary = expected + 3; }); s.spec = capacityModelIntent(); delete s.spec.decomposition; s.variant = String(expected); });
When('模型省略并行分解并返回完整目标引用和验收要求', async function (this: SpecWorld) { interpret(model(this), state(this).spec!); await fixture(this).recognize(); });
Then('负责人应取得全部八份文档且不派发分片', function (this: SpecWorld) {
  const s = state(this), m = model(this), f = fixture(this); assert.equal(m.work.payload.maxPartitions, Number(s.variant)); assert.equal(m.pending('assistance').length, 0);
  assert.deepEqual((m.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, s.spec); assert.deepEqual((m.pending('owner')[0]!.payload.conversation as { artifacts: unknown }).artifacts, m.context.history!.artifacts);
  f.assertOwnerFallback(); assert.deepEqual(f.context().inputAnalyses![0]!.spec, groupedIntent(Number(s.variant))); assert.equal(f.requests.length, 1); assert.equal(f.context().usage.retries, 0);
});
Given('本次理解固定最大分片数为四', function (this: SpecWorld) { const value = new MapCapacityFixture(); value.firstOverCapacity = true; state(this).fixture = value; });
When('模型首次返回八个分片并在有界修复后返回四个完整分组', async function (this: SpecWorld) { const value = fixture(this); await value.recognize(); value.assertPlan(); await value.beginParallel(); await value.finish(); });
Then('八片计划应未被应用且四片计划完整执行', function (this: SpecWorld) { const value = fixture(this); assert.equal(value.context().discussion?.mapReduce?.partitions.length, 4); assert.equal(value.context().outcome, 'complete'); });
Then('修复应只追加一次请求授权并消耗现有额度', function (this: SpecWorld) { const value = fixture(this); assert.equal(value.requests.filter(request => request.kind === 'interpretation').length, 2); assert.equal(value.context().usage.retries, 1); assert.deepEqual(value.beforeProviderOrdinary, [1, 2]); assert.equal(value.work.payload.maxPartitions, 4); assert.equal(value.work.outputRepair?.issue, 'invalid_input_intent'); });
Given('理解时四片计划合法但派发前发生{string}', function (this: SpecWorld, change: string) {
  const s = state(this), m = new CapacityModel(); m.claim(); m.consume(); assert.equal(m.work.payload.maxPartitions, 8);
  if (change === '所有成员忙碌') m.busyAllMembers(); else if (change === '协助余额降低') m.context.usage.assists = 17; else { assert.equal(change, '普通余额降低'); m.context.usage.ordinary = 25; }
  s.model = m; s.fixture = prepareDispatchDecrease(change); s.variant = change; s.beforeUsage = structuredClone(s.fixture.context().usage); s.beforeModelUsage = structuredClone(m.context.usage);
});
When('状态机重新核对当前分片容量', function (this: SpecWorld) { const m = model(this), f = fixture(this); assert(m.interpret().ok); assert(f.result(f.work, groupedIntent(4)).ok); });
Then('应说明{string}且将全部分片和归并要求交给原负责人', function (this: SpecWorld, reason: string) {
  const m = model(this), f = fixture(this); assert.equal(m.context.discussion, undefined); assert.equal(m.pending('assistance').length, 0); assert.equal(m.pending('owner').length, 1); assert.deepEqual((m.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, capacityModelIntent()); assert(m.context.messages.at(-1)!.text.includes(reason));
  assert.equal(f.context().discussion, undefined); assert.equal(f.pending('owner').length, 1); assert.deepEqual((f.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, groupedIntent(4)); assert(f.context().messages.some(message => message.text.includes(reason)));
});
Then('不应部分派发丢弃文档或重复扣费', function (this: SpecWorld) { const s = state(this); assert.deepEqual(model(this).context.usage, s.beforeModelUsage); assert.equal(fixture(this).pending('assistance').length, 0); assert.deepEqual(fixture(this).context().usage, s.beforeUsage); });
Given('旧快照保留合法分片计划但没有容量字段且资源{string}', function (this: SpecWorld, resources: string) {
  assert(resources === '充足' || resources === '不足'); const s = state(this), limited = resources === '不足'; s.variant = resources;
  const m = new CapacityModel(); m.claim(); m.consume(); delete m.work.payload.maxPartitions; m.snapshot = restoreTask(structuredClone(persistTask(m.snapshot))); if (limited) m.context.usage.assists = 17;
  s.model = m; s.fixture = prepareLegacyCapacity(limited);
});
When('恢复后在当前资源边界派发', async function (this: SpecWorld) {
  const s = state(this), m = model(this), f = fixture(this); assert(m.send({ type: 'RECOVER', config: m.context.config }).ok); m.claim(); m.consume(); assert(m.interpret().ok);
  f.reopen(); const work = f.claim(); assert(f.result(work, groupedIntent(4)).ok); s.dispatch = structuredClone(f.context()); const count = f.context().intents.length; s.duplicate = !!f.result(work, groupedIntent(4)).duplicate; s.unchangedCount = count === f.context().intents.length;
  if (s.variant === '充足') {
    const first = f.pending('assistance')[0]!; assert(await f.run()); s.originalReads = [...f.documentReads]; f.reopen(); f.reopen(); s.firstDone = f.context().intents.find(item => item.id === first.id)!.status === 'done'; s.recoveredPending = f.pending('assistance').length;
    assert(await f.run()); assert(await f.run()); assert(await f.run()); s.replayedReads = f.documentReads.filter(url => s.originalReads!.includes(url)); await f.finish();
  }
});
Then('应完整派发或带原因完整回退且不重复安排已完成分片', function (this: SpecWorld) {
  const s = state(this), m = model(this), f = fixture(this), limited = s.variant === '不足', dispatched = s.dispatch!;
  assert(!Object.hasOwn(m.work.payload, 'maxPartitions')); assert(!Object.hasOwn(f.work.payload, 'maxPartitions')); assert.equal(m.context.inputAnalyses![0]!.decompositionApplied, true); assert.deepEqual(m.context.inputAnalyses![0]!.spec, capacityModelIntent()); assert.equal(m.pending('assistance').length, limited ? 0 : 4); assert.equal(m.pending('owner').length, limited ? 1 : 0);
  assert.equal(dispatched.inputAnalyses![0]!.decompositionApplied, true); assert.deepEqual(dispatched.inputAnalyses![0]!.spec, groupedIntent(4)); assert.equal(dispatched.intents.filter(work => work.kind === 'assistance' && work.status === 'pending').length, limited ? 0 : 4); assert.equal(dispatched.intents.filter(work => work.kind === 'owner' && work.status === 'pending').length, limited ? 1 : 0); assert.equal(s.duplicate, true); assert.equal(s.unchangedCount, true);
  if (limited) { assert(dispatched.messages.some(message => message.text.includes('协助额度不足'))); assert.deepEqual((f.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, groupedIntent(4)); }
  else { assert.equal(s.firstDone, true); assert.equal(s.recoveredPending, 3); assert.deepEqual(s.replayedReads, s.originalReads); assert.equal(f.context().outcome, 'complete'); assert.equal(f.requests.filter(request => request.kind === 'discussionSummary').length, 1); assert.equal(f.requests.filter(request => request.kind === 'owner').length, 1); }
});
Given('无容量字段的历史输入理解尚未领取', function (this: SpecWorld) { const s = state(this); s.model = new CapacityModel(); delete s.model.work.payload.maxPartitions; s.fixture = prepareLegacyPendingCapacity(); });
When('恢复并领取历史输入理解后返回完整四片计划', function (this: SpecWorld) { const m = model(this), f = fixture(this); assert(m.send({ type: 'RECOVER', config: m.context.config }).ok); interpret(m); f.reopen(); const work = f.claim(); assert(f.result(work, groupedIntent(4)).ok); });
Then('应沿用历史理解协议且完整派发四片', function (this: SpecWorld) { assert(!Object.hasOwn(model(this).work.payload, 'maxPartitions')); assert.equal(model(this).pending('assistance').length, 4); assert(!Object.hasOwn(fixture(this).work.payload, 'maxPartitions')); assert.equal(fixture(this).pending('assistance').length, 4); });
Given('输入理解首次领取后的容量为三且本次请求遇到瞬时失败', function (this: SpecWorld) { const s = state(this), m = new CapacityModel(input => { input.config.limits.ordinary = 6; }); m.claim(); m.consume(); assert.equal(m.work.payload.maxPartitions, 3); assert(m.send({ type: 'WORK_FAILED', intentId: m.work.id, transient: true, reason: 'temporary transport failure' }).ok); s.model = m; s.fixture = prepareRetriedCapacitySnapshot(); });
When('自动重试重新领取并返回两个完整分组', function (this: SpecWorld) { model(this).claim(); model(this).consume(); const value = fixture(this), work = value.claim(); assert(value.event({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok); assert(value.result(work, groupedIntent(2)).ok); });
Then('容量应按第二次收费刷新为二且累计只收两次普通请求', function (this: SpecWorld) { assert.equal(model(this).work.payload.maxPartitions, 2); assert.equal(model(this).context.usage.ordinary, 2); const value = fixture(this); assert.equal(value.work.payload.maxPartitions, 2); assert.equal(value.context().usage.ordinary, 2); assert.equal(value.pending('assistance').length, 2); });
Given('本次输入理解的固定容量不足并行为{int}', function (this: SpecWorld, maximum: number) { assert(maximum === 0 || maximum === 1); state(this).protocol = new CapacityAdapterScenario(maximum, true); });
When('模型返回八片而修复后保留完整普通任务', async function (this: SpecWorld) { await state(this).protocol!.run(); });
Then('应拒绝超限分解并仅为一次有界修复追加授权', function (this: SpecWorld) { state(this).protocol!.assertResult(); });
Given('理解模型尝试在输出中把固定容量四改为八', function (this: SpecWorld) { const f = new MapCapacityFixture(); f.firstCapacityOverride = true; state(this).fixture = f; });
When('宿主验证并修复这份输入理解', async function (this: SpecWorld) { await fixture(this).recognize(); });
Then('应拒绝容量字段并保留宿主上限四', function (this: SpecWorld) { const f = fixture(this); f.assertPlan(); assert.equal(f.context().usage.retries, 1); assert(!Object.hasOwn(f.context().inputAnalyses![0]!.spec!, 'maxPartitions')); assert.equal(f.work.payload.maxPartitions, 4); });
Given('历史理解工作缺少容量字段且模型返回八个合法分片', function (this: SpecWorld) { state(this).protocol = new CapacityAdapterScenario(undefined); });
When('按历史理解协议验证模型输出', async function (this: SpecWorld) { await state(this).protocol!.run(); });
Then('应保留八片完整计划且无需格式修复', function (this: SpecWorld) { state(this).protocol!.assertResult(); });
