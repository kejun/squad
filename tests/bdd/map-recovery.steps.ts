import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { deliveryCheckMaterials } from '../../src/delivery-check-delta.js';
import { absentRecovery, assertNoRecovery, claimRecoveryCheck, failedMap, failedRecoveryJudgment, fullRecovery, independentReviewRecovery, independentReviewRun,
  invalidRecovery, invalidRecoveryJudgment, newInputRecovery, partialRecovery, preparedRecovery, restartRecovery, stopRecovery, type RecoveryRun } from '../map-recovery-model-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, RecoveryRun>();
const formatted = new WeakMap<SpecWorld, { outcome: string | null; cliCalls: number; resolutions: number; formatRepairs: number }>();
const run = (world: SpecWorld) => runs.get(world)!;
Given('八个分片中七片失败一片成功且负责人取得全部资料的完整回执', function (this: SpecWorld) { runs.set(this, failedMap()); });
When('负责人为七片提交恢复声明且原要求与逐片恢复验收全部通过', function (this: SpecWorld) { fullRecovery(run(this)); });
Then('应发布当前候选且保留七条原失败结果及对应恢复证明', async function (this: SpecWorld) {
  assert.equal(run(this).m.context.outcome, 'complete');
  assert.equal(run(this).m.queue.filter(part => part.resolution).length, 7);
  const { verifyMapRecoveryIntegration } = await import('../map-recovery-acceptance.js');
  await verifyMapRecoveryIntegration();
});
When('负责人只为部分失败分片提交恢复声明且所有本次验收项通过', function (this: SpecWorld) { partialRecovery(run(this)); });
Then('应保存本次验收结论并因剩余缺口部分结束而不发布', function (this: SpecWorld) {
  assert.equal(run(this).m.context.outcome, 'partial'); assertNoRecovery(run(this));
});
When('负责人仅声称已补齐且检查模型全部通过', function (this: SpecWorld) { absentRecovery(run(this)); });
Then('应保留未解决分片并部分结束而不登记恢复', function (this: SpecWorld) { assert.equal(run(this).m.context.outcome, 'partial'); assertNoRecovery(run(this)); });
When('负责人提交包含{string}的恢复声明', function (this: SpecWorld, problem: string) { invalidRecovery(problem, run(this)); });
Then('应拒绝该恢复进入独立检查并保留原失败记录', function (this: SpecWorld) { assert.equal(run(this).m.pending('check').length, 0); assertNoRecovery(run(this)); });
Given('七片恢复声明已绑定当前候选和完整来源', function (this: SpecWorld) { runs.set(this, preparedRecovery()); });
When('检查员把逐片恢复判为通过但没有提供原文引用', function (this: SpecWorld) { invalidRecoveryJudgment('missing', run(this)); });
When('检查员用{string}证明恢复', function (this: SpecWorld, problem: string) { invalidRecoveryJudgment(problem === '声明外来源' ? 'unauthorized' : 'wrong', run(this)); });
Then('应拒绝恢复结论并保留有界技术补试且不登记恢复', function (this: SpecWorld) { assert.equal(run(this).m.context.deliveryCycle?.retry?.status, 'reserved'); assertNoRecovery(run(this)); });
When('检查员将一片恢复判为{string}', function (this: SpecWorld, judgment: string) { failedRecoveryJudgment(judgment === '失败' ? 'failed' : 'unverified', run(this)); });
Then('不得发布或登记恢复且应保留该片的当前结论', function (this: SpecWorld) { assertNoRecovery(run(this)); assert(run(this).m.context.intents.some(work => work.criteriaResults?.some(item => item.status !== 'passed'))); });
When('用户停止任务后收到全部恢复通过结果', function (this: SpecWorld) { stopRecovery(run(this)); });
Then('应保持停止且不得登记恢复或发布', function (this: SpecWorld) { assert(run(this).m.context.stopped); assertNoRecovery(run(this)); });
When('重启后接收当前合法通过回执并重复接收该回执', function (this: SpecWorld) { restartRecovery(run(this)); });
Then('应只发布一次并保留一次检查费用及同一组恢复证明', function (this: SpecWorld) { assert.equal(run(this).m.context.usage.checks, 1); assert.equal(run(this).m.queue.filter(part => part.resolution).length, 7); });
When('用户补充新要求后旧候选的全部恢复通过结果到达', function (this: SpecWorld) { newInputRecovery(run(this)); });
Then('应先应用新输入且不得用旧结论登记恢复或发布', function (this: SpecWorld) { assertNoRecovery(run(this)); assert.equal(run(this).m.context.outcome, null); });
Given('当前任务保留未完成的独立成员评审', function (this: SpecWorld) { runs.set(this, independentReviewRun()); });
When('负责人提交分片恢复声明并声称已完成评审', function (this: SpecWorld) { independentReviewRecovery(run(this)); });
Then('不得据此结清独立成员评审或发布', function (this: SpecWorld) { assert.equal(run(this).m.context.review?.incomplete, '独立审查尚未完成'); assertNoRecovery(run(this)); });
When('独立检查准备验收负责人补齐的候选', function (this: SpecWorld) { claimRecoveryCheck(run(this)); });
Then('应收到每片原目标预期结果归并要求和指定冻结来源', function (this: SpecWorld) {
  const r = run(this), check = r.m.context.intents.find(work => work.kind === 'check' && work.status === 'inflight')!;
  const materials = deliveryCheckMaterials(r.m.context, check)!;
  assert.equal(materials.delta, undefined);
  assert.equal(materials.requirements.filter(item => item.requiredSourceIds).length, 7);
  for (const claim of r.claims) {
    const partition = r.m.context.discussion!.mapReduce!.partitions.find(part => part.id === claim.partitionId)!;
    const criterion = materials.requirements.find(item => item.id.endsWith(`:${claim.partitionId}`))!;
    assert(criterion.text.includes(partition.objective)); assert(criterion.text.includes(partition.expectedOutput));
    assert(criterion.text.includes(r.m.context.discussion!.mapReduce!.synthesis)); assert.deepEqual(criterion.requiredSourceIds, [r.sourceId]);
  }
  assert(materials.evidence.find(item => item.id === r.sourceId)?.stdout?.includes('完整doc-8正文'));
});
Then('不得只凭负责人自述或命令成功判定恢复', async function (this: SpecWorld) {
  assert(run(this).m.context.candidate!.acceptance!.criteria.filter(item => item.requiredSourceIds).every(item => item.text.includes('负责人自述不足以证明恢复')));
  assertNoRecovery(run(this));
  const { verifyMapRecoveryRejectedContentIntegration } = await import('../map-recovery-acceptance.js');
  await verifyMapRecoveryRejectedContentIntegration();
});

Given('模型已取得七片恢复所需的完整来源', function (this: SpecWorld) { runs.set(this, failedMap()); });
When('模型先把恢复声明放在普通回答再修正为交付', async function (this: SpecWorld) {
  const { verifyMapRecoveryWrongOutputIntegration } = await import('../map-recovery-acceptance.js');
  formatted.set(this, await verifyMapRecoveryWrongOutputIntegration());
});
Then('应明确反馈协议问题且只读取一次资料并通过正确声明完成发布', function (this: SpecWorld) {
  const result = formatted.get(this)!;
  assert.equal(result.outcome, 'complete'); assert.equal(result.cliCalls, 1);
  assert.equal(result.resolutions, 7); assert.equal(result.formatRepairs, 1);
});
