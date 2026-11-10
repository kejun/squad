import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { MapReduceFixture, mapIntent } from '../map-reduce-fixture.js';
import { MapModel, modelMapIntent } from '../map-model-gate-fixture.js';
import { executionState, persistTask, restoreTask } from '../../src/task.machine.js';
import { inputIntentSchema } from '../../src/input-intent.js';
import type { Intent, TaskInput } from '../../src/types.js';
import type { SpecWorld } from './steps.js';
interface State { fixture: MapReduceFixture; model: MapModel; maps?: Intent[]; old?: Intent; duplicateRejected?: boolean; restoredResults?: number; restoredPending?: number; invalid?: boolean[]; failure?: string }
const states = new WeakMap<SpecWorld, State>();
const s = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };
const create = (world: SpecWorld, fixture = new MapReduceFixture(), model = new MapModel()) => { const value: State = { fixture, model }; states.set(world, value); return value; };
After(async function (this: SpecWorld) { const state = states.get(this); if (state) { state.fixture.releaseMaps(); await state.fixture.parallel; state.fixture.close(); states.delete(this); } });
Given('用户请求分别研究两个来源再汇总并已识别为独立分片任务', async function (this: SpecWorld) { const { fixture, model } = create(this); model.interpret(); await fixture.recognize(); });
When('状态机接受分片意图且执行器同时运行两个成员', async function (this: SpecWorld) { const value = s(this); value.maps = [value.model.claim(value.model.pending('assistance')[0]!), value.model.claim(value.model.pending('assistance')[0]!)]; await value.fixture.beginParallel(); });
Then('两个成员应在任一返回前均已开始且收到不同分片和完整用户约束', function (this: SpecWorld) {
  const { fixture, model, maps } = s(this); fixture.assertParallel();
  assert.deepEqual(model.context.intents.filter(work => work.status === 'inflight').map(work => work.target), ['B', 'builder-1']);
  for (const work of maps!) assert.equal(executionState(model.snapshot, work.id, work.attempt), 'authorized');
  assert.deepEqual(model.context.discussion!.mapReduce!.assignments.map(({ partitionId, target }) => ({ partitionId, target })), [{ partitionId: 'alpha', target: 'B' }, { partitionId: 'beta', target: 'builder-1' }]);
  assert.deepEqual(maps!.map(work => work.payload.partition), modelMapIntent().decomposition!.partitions);
  assert.deepEqual((maps![0]!.payload.goal as TaskInput['goal']).constraints, ['仅使用公开资料']); assert.equal(model.pending('owner').length, 0);
});
When('全部分片返回并完成归并', async function (this: SpecWorld) {
  const { model, maps, fixture } = s(this); assert(model.answer(maps![1]!).ok); assert.equal(model.pending('discussionSummary').length, 0);
  assert(model.answer(maps![0]!).ok); assert.equal(model.pending('discussionSummary').length, 1); assert(model.answer(model.claim(model.pending('discussionSummary')[0]!)).ok);
  await fixture.finishMaps();
});
Then('原负责人应只续办一次并收到全部原始结果', async function (this: SpecWorld) {
  const { model, fixture } = s(this); assert.equal(model.pending('owner').length, 1);
  const round = model.pending('owner')[0]!.payload.discussion as { status: string; results: { target: string }[] };
  assert.equal(round.status, 'delivered'); assert.deepEqual(round.results.map(result => result.target), ['builder-1', 'B']);
  fixture.assertHandoff(); await fixture.drain(); assert.equal(fixture.context().outcome, 'complete'); assert.equal(fixture.requests.filter(request => request.kind === 'owner').length, 1);
});
Given('分片计划受到{string}', function (this: SpecWorld, limit: string) {
  create(this, new MapReduceFixture(limit), new MapModel(input => {
    if (limit === '普通额度不足') input.config.limits.ordinary = 4;
    else if (limit === '协助额度不足') input.config.limits.assists = 1;
    else { assert.equal(limit, '可用成员不足'); input.config.bots = input.config.bots.slice(0, 1); }
  }));
});
When('状态机接受该任务的输入解释', function (this: SpecWorld) { const { model, fixture } = s(this); model.interpret(); assert(fixture.submit('分别研究甲乙两个来源；必须仅使用公开资料并保留出处；最后汇总差异').ok); const work = fixture.claim(); assert(fixture.result(work, mapIntent()).ok); });
Then('应保留全部任务给负责人且说明未并行原因', function (this: SpecWorld) {
  const { model, fixture } = s(this); assert.equal(model.pending('assistance').length, 0); assert.equal(model.pending('owner').length, 1); assert.equal(model.context.usage.assists, 0); assert(model.context.messages.at(-1)!.text.includes('未启动并行分片'));
  assert.equal(fixture.pending('assistance').length, 0); assert.equal(fixture.pending('owner').length, 1); assert.equal(fixture.context().usage.assists, 0); assert(fixture.context().messages.some(message => message.text.includes('未启动并行分片')));
  assert.deepEqual((fixture.pending('owner')[0]!.payload.inputIntents as { spec: { decomposition: unknown } }[])[0]!.spec.decomposition, mapIntent().decomposition);
});
Given('两个独立分片已启动且其中一个{string}', async function (this: SpecWorld, failure: string) {
  const value = create(this); value.failure = failure; const { model, fixture } = value; model.interpret(); const work = model.claim(model.pending('assistance')[0]!);
  if (failure === '部分完成') assert(model.answer(work, 'partial').ok);
  else { assert.equal(failure, '失败'); assert(model.send({ type: 'WORK_FAILED', intentId: work.id, transient: false, reason: 'failure' }).ok); }
  fixture.failure = failure; await fixture.recognize(); await fixture.run();
});
When('另一个分片和归并工作返回', async function (this: SpecWorld) { const { model, fixture } = s(this); assert(model.answer(model.claim(model.pending('assistance')[0]!)).ok); assert(model.answer(model.claim(model.pending('discussionSummary')[0]!)).ok); await fixture.drain(); });
Then('原负责人应收到失败分片和成功分片且任务不得被标为完整完成', function (this: SpecWorld) {
  const { model, fixture } = s(this); assert(model.context.discussion!.incomplete); const result = (model.pending('owner')[0]!.payload.discussion as { results: { status: string }[] }).results; assert.equal(result[0]!.status, s(this).failure === '部分完成' ? 'partial' : 'failed'); assert.equal(result[1]!.status, 'success');
  if (s(this).failure === '部分完成') assert(model.context.discussion!.incomplete!.includes('未完整完成'));
  assert.equal(fixture.context().outcome, 'partial'); assert(fixture.context().discussion?.incomplete); assert.equal(fixture.context().discussion?.results.length, 2); const owner = fixture.requests.find(request => request.kind === 'owner'); assert(owner); assert(JSON.stringify(owner.context).includes('beta 原始证据')); assert((owner.context.discussion as { incomplete?: string }).incomplete);
});
Given('两个独立分片已领取后发生{string}', async function (this: SpecWorld, change: string) {
  const value = create(this), { model, fixture } = value; model.interpret(); value.maps = [model.claim(model.pending('assistance')[0]!), model.claim(model.pending('assistance')[0]!)];
  assert(model.send(change === '停止' ? { type: 'STOP' } : { type: 'USER_INPUT', text: '新目标', goal: { ...model.context.goal, text: '新目标' } }).ok);
  await fixture.recognize(); value.old = fixture.claimMaps()[0]!; if (change === '停止') assert(fixture.event({ type: 'STOP' }).ok); else assert(fixture.submit('新目标', { id: 'changed-goal', goal: { ...fixture.context().goal, text: '新目标' } }).ok);
});
When('旧分片结果提交', function (this: SpecWorld) { const { model, maps, fixture, old } = s(this); assert.equal(model.answer(maps![0]!).ok, false); assert.equal(fixture.record(old!).ok, false); });
Then('旧结果应被拒绝且不得启动旧归并工作', function (this: SpecWorld) { const { model, fixture } = s(this); assert.equal(model.context.discussion?.status, 'cancelled'); assert.equal(model.pending('discussionSummary').length, 0); assert.equal(fixture.context().discussion?.status, 'cancelled'); assert.equal(fixture.pending('discussionSummary').length, 0); });
Given('一个分片已经持久化到SQLite', async function (this: SpecWorld) { const value = create(this, new MapReduceFixture(undefined, true)); value.model.interpret(); value.maps = [value.model.claim(value.model.pending('assistance')[0]!)]; assert(value.model.answer(value.maps[0]!).ok); await value.fixture.recognize(); const work = value.fixture.engine.claim(value.fixture.room, value.fixture.task, value.fixture.pending('assistance')[0]!.id); assert(work); assert(value.fixture.record(work).ok); });
When('重启两次并提交重复分片结果后执行剩余任务', async function (this: SpecWorld) {
  const value = s(this), { model, fixture } = value; model.snapshot = restoreTask(persistTask(model.snapshot)); model.snapshot = restoreTask(persistTask(model.snapshot)); value.restoredResults = model.context.discussion!.results.length; value.restoredPending = model.pending('assistance').length; value.duplicateRejected = !model.answer(value.maps![0]!).ok; assert(model.answer(model.claim(model.pending('assistance')[0]!)).ok);
  fixture.reopen(); fixture.reopen(); assert(fixture.engine.send(fixture.room, fixture.task, fixture.repeated!).duplicate); await fixture.drain();
});
Then('应只执行剩余分片并只安排一次归并及负责人续办', function (this: SpecWorld) { const value = s(this), { model, fixture } = value; assert.equal(value.restoredResults, 1); assert.equal(value.restoredPending, 1); assert.equal(value.duplicateRejected, true); assert.equal(model.pending('discussionSummary').length, 1); assert.equal(fixture.context().outcome, 'complete'); for (const kind of ['assistance', 'discussionSummary', 'owner']) assert.equal(fixture.requests.filter(request => request.kind === kind).length, 1); });
Given('意图未提出分片或者包含重复分片身份或指定成员', function (this: SpecWorld) { create(this); });
When('状态机核验这些输入意图', function (this: SpecWorld) { const value = s(this), ordinary = modelMapIntent(); delete ordinary.decomposition; value.model.interpret(ordinary); assert(value.fixture.submit().ok); const work = value.fixture.claim(), plain = mapIntent(); delete plain.decomposition; assert(value.fixture.result(work, plain).ok); const duplicate = mapIntent(); duplicate.decomposition!.partitions[1]!.id = 'alpha'; const selected = mapIntent(); Object.assign(selected.decomposition!.partitions[0]!, { target: 'A' }); value.invalid = [inputIntentSchema.safeParse(duplicate).success, inputIntentSchema.safeParse(selected).success]; });
Then('普通意图应沿用负责人路径而非法分片契约应被拒绝', function (this: SpecWorld) { const { model, fixture, invalid } = s(this); assert.equal(model.pending('owner').length, 1); assert.equal(model.pending('assistance').length, 0); assert.equal(fixture.pending('owner').length, 1); assert.equal(fixture.pending('assistance').length, 0); assert.deepEqual(invalid, [false, false]); });
Given('负责人正在处理尚未分片的普通任务', function (this: SpecWorld) { const { model, fixture } = create(this); const ordinary = modelMapIntent(); delete ordinary.decomposition; model.interpret(ordinary); assert(fixture.submit().ok); const work = fixture.claim(), plain = mapIntent(); delete plain.decomposition; assert(fixture.result(work, plain).ok); });
When('用户补充两个独立来源且输入理解确认可并行', function (this: SpecWorld) { const { model, fixture } = s(this); assert(model.send({ type: 'USER_INPUT', text: '分别研究甲乙两个来源并汇总' }).ok); model.interpret({ ...modelMapIntent(), action: 'supplement' }); assert(fixture.submit('分别研究甲乙两个来源并汇总', { id: 'supplement' }).ok); const work = fixture.claim(); assert(fixture.result(work, { ...mapIntent(), action: 'supplement' }).ok); });
Then('应在安全输入边界仅安排这两个分片而不同时续办负责人', function (this: SpecWorld) { const { model, fixture } = s(this); assert.equal(model.pending('assistance').length, 2); assert.equal(model.pending('owner').length, 0); assert.equal(model.context.inputAnalyses!.at(-1)!.decompositionApplied, true); assert.equal(fixture.pending('assistance').length, 2); assert.equal(fixture.pending('owner').length, 0); assert.equal(fixture.context().inputAnalyses!.at(-1)!.decompositionApplied, true); });
