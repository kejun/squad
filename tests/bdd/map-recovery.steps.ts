import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { MapQueueModel } from '../map-queue-fixture.js';
import { settledDirectMap, ordinaryDelivery, finishOrdinary, legacyDeclaration, prepareRetiredSnapshot,
  prepareUnknownEffects, childResultModel, type DirectMapRun } from '../direct-map-delivery-model-fixture.js';
import { directMapEngineAcceptance } from '../direct-map-delivery-acceptance.js';
import { restoreTask } from '../../src/task.machine.js';
import { deliveryCheckMaterials } from '../../src/delivery-check-delta.js';
import type { Intent } from '../../src/types.js';

type State = { run?: DirectMapRun; model?: MapQueueModel; work?: Intent; status?: 'success' | 'partial' | 'failed';
  unknown?: ReturnType<typeof prepareUnknownEffects>; kind?: string; reply?: { ok: boolean }; prior?: unknown; legacy?: ReturnType<typeof prepareRetiredSnapshot>; integration?: Awaited<ReturnType<typeof directMapEngineAcceptance>> };
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; };
const model = (world: SpecWorld) => state(world).model!;
const run = (world: SpecWorld) => state(world).run!;
const timeout = { timeout: 20_000 };
function child(world: SpecWorld, status: 'success' | 'partial' | 'failed') {
  const value = state(world), m = new MapQueueModel(input => { input.goal.partitionResources = { 'part-1': [{ kind: 'url', url: 'https://example.test/doc-1' }] }; });
  value.model = m; value.work = m.start(); value.status = status;
  if (status === 'failed') { const good = m.start(); assert(m.answer(good).ok); value.prior = structuredClone(m.context.discussion!.results[0]); }
}
Given('八个分片中七片失败一片成功且负责人已经汇总', function (this: SpecWorld) { state(this).run = settledDirectMap(); });
When('负责人不提交补救声明并完成普通交付检查', timeout, async function (this: SpecWorld) {
  assert(ordinaryDelivery(run(this)).ok); finishOrdinary(run(this)); state(this).integration = await directMapEngineAcceptance();
});
Then('应按普通检查发布且不生成分片补救验收项或恢复证明', function (this: SpecWorld) {
  assert.equal(run(this).m.context.outcome, 'complete'); assert.equal(state(this).integration!.ownerRequests, 1);
});
Given('子Agent没有来源回执但报告分片成功并提交正文', function (this: SpecWorld) { child(this, 'success'); });
Given('子Agent将夹带正文和文件的结果标为失败', function (this: SpecWorld) { child(this, 'failed'); });
Given('子Agent报告部分成功并提交已有正文和文件', function (this: SpecWorld) { child(this, 'partial'); });
When('系统接收该子Agent结果', function (this: SpecWorld) {
  const s = state(this), work = s.work!;
  assert(model(this).send({ type: 'DISCUSSION_RESULT', workId: work.id, fence: work, attempt: work.attempt, discussionId: work.discussionId!,
    status: s.status!, text: '子Agent正文', artifacts: [{ name: 'child.md', content: '子Agent文件' }] }).ok);
});
Then('应保留成功状态及原正文而不追加内容核对', function (this: SpecWorld) {
  const result = model(this).context.discussion!.results.find(r => r.workId === state(this).work!.id)!;
  assert.equal(result.status, 'success'); assert.equal(result.answer, '子Agent正文'); assert.equal(result.artifactIds.length, 1);
});
Then('负责人应收到失败状态和空交付且其他成功结果保持不变', function (this: SpecWorld) {
  const s = state(this), results = model(this).context.discussion!.results;
  const result = results.find(r => r.workId === s.work!.id)!;
  assert.equal(result.status, 'failed'); assert.equal(result.answer, ''); assert.deepEqual(result.artifactIds, []);
  assert.deepEqual(results[0], s.prior); assert(!model(this).context.artifacts.some(a => a.content === '子Agent文件'));
});
Given('负责人输出中仍夹带{string}补救信息', function (this: SpecWorld, kind: string) { const s = state(this); s.run = settledDirectMap(); s.kind = kind; });
When('系统处理这次普通交付', function (this: SpecWorld) { assert(ordinaryDelivery(run(this), legacyDeclaration(state(this).kind!)).ok); });
Then('应忽略遗留申报且不返回补救错误或要求重新申报', function (this: SpecWorld) {
  assert.equal(run(this).m.context.candidate?.deliveryIssue, undefined); assert.equal(run(this).m.pending('owner').length, 0); finishOrdinary(run(this));
});
When('普通检查员仅检查原任务要求且不给出补救来源引用', function (this: SpecWorld) { assert(ordinaryDelivery(run(this)).ok); finishOrdinary(run(this)); });
Then('应接受原任务检查结论而不产生补救来源错误', function (this: SpecWorld) { assert.equal(run(this).m.context.outcome, 'complete'); });
Given('子Agent的执行结果是{string}', function (this: SpecWorld, kind: string) { const s = state(this); s.kind = kind; s.model = new MapQueueModel(); s.work = s.model.start(); });
When('系统结算该子Agent工作', function (this: SpecWorld) {
  const s = state(this); assert(model(this).send({ type: 'WORK_FAILED', intentId: s.work!.id, fence: s.work!, transient: false,
    reason: s.kind === '超时' ? 'deadline 超时诊断' : '执行失败诊断' }).ok);
});
Then('应保留执行诊断且交给负责人的正文和文件均为空', function (this: SpecWorld) {
  const s = state(this), result = model(this).context.discussion!.results.find(r => r.workId === s.work!.id)!;
  assert.equal(result.status, s.kind === '超时' ? 'timeout' : 'failed'); assert.equal(result.answer, ''); assert.deepEqual(result.artifactIds, []); assert(result.reason?.includes('诊断'));
});
Then('应保留部分成功及其内容而不追加补救验收', function (this: SpecWorld) {
  const result = model(this).context.discussion!.results.find(r => r.workId === state(this).work!.id)!;
  assert.equal(result.status, 'partial'); assert.equal(result.answer, '子Agent正文'); assert.equal(result.artifactIds.length, 1);
});
Given('分片工作已经开始且用户停止了任务', function (this: SpecWorld) { const s = state(this); s.model = new MapQueueModel(); s.work = s.model.start(); assert(s.model.send({ type: 'STOP' }).ok); });
When('原子Agent的成功结果迟到', function (this: SpecWorld) { state(this).reply = model(this).answer(state(this).work!); });
Then('应保持停止且不得消费该迟到交付', function (this: SpecWorld) { assert.equal(state(this).reply!.ok, false); assert(model(this).context.stopped); });
Given('旧任务保存了补救声明证明及逐片验收信息', function (this: SpecWorld) { state(this).legacy = prepareRetiredSnapshot(); });
When('宿主恢复该任务', function (this: SpecWorld) { const s = state(this); s.legacy!.run.m.snapshot = restoreTask(s.legacy!.raw); });
Then('活动上下文不应再包含补救协议且成功分片不应重新执行', function (this: SpecWorld) {
  const s = state(this).legacy!, c = s.run.m.context;
  assert(!Reflect.has(c.candidate!, 'partitionRecoveries')); assert(c.candidate!.acceptance!.criteria.every(r => !r.id.startsWith('map-recovery:')));
  assert.equal(c.reason, ''); assert.deepEqual(c.usage, s.spent); assert.deepEqual(s.run.m.queue.map(p => p.attempt), s.attempts);
});
Given('分片执行期间用户已经更新目标', function (this: SpecWorld) { const s = state(this); s.model = new MapQueueModel(); s.work = s.model.start(); assert(s.model.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok); });
When('旧目标子Agent提交成功结果', function (this: SpecWorld) { state(this).reply = model(this).answer(state(this).work!); });
Then('应保留新目标且拒绝旧结果覆盖', function (this: SpecWorld) { assert.equal(state(this).reply!.ok, false); assert.equal(model(this).context.goal.text, '新目标'); });
Given('子Agent仍有未决物理执行且模型输出夹带旧补救字段', function (this: SpecWorld) { state(this).unknown = prepareUnknownEffects(); });
When('系统处理这份附带旧补救字段的输出', function (this: SpecWorld) {
  const { m, work } = state(this).unknown!;
  state(this).reply = m.send({ type: 'DELIVER', workId: work.id, fence: work, text: '旧声明不能结算物理效果', artifactIds: [], partitionRecoveries: legacyDeclaration('成功分片') });
});
Then('不得因此释放未决执行资源或改变宿主授权', function (this: SpecWorld) { const { m, work, operations } = state(this).unknown!; assert.equal(state(this).reply!.ok, false); assert.deepEqual(m.c.intents.find(w => w.id === work.id)!.localOperations, operations); });
When('系统准备普通交付检查材料', function (this: SpecWorld) { assert(ordinaryDelivery(run(this)).ok); run(this).m.start(run(this).m.pending('check')[0]!); });
Then('检查材料应包含原要求且不包含逐片补救验收说明', function (this: SpecWorld) {
  const r = run(this), work = r.m.context.intents.find(w => w.kind === 'check' && w.status === 'inflight')!;
  const materials = deliveryCheckMaterials(r.m.context, work)!;
  assert(materials.requirements.length); assert(!JSON.stringify(materials.requirements).includes('map-recovery:'));
});
Given('模型仍在普通回答中附带旧分片补救字段', function (this: SpecWorld) { state(this).kind = 'legacy-answer'; });
When('真实模型适配器处理该回答并完成普通交付', timeout, async function (this: SpecWorld) { state(this).integration = await directMapEngineAcceptance(state(this).kind === 'legacy-answer'); });
Then('不应为该遗留字段增加请求或陷入补救循环', function (this: SpecWorld) { assert.equal(state(this).integration!.outcome, 'complete'); assert.equal(state(this).integration!.ownerRequests, 1); });
Then('失败结果中不会交付的无效文件结构不得触发重新申报',function(){childResultModel('failed','失败诊断',true);});
