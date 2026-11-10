import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { sourceClaimsModel, submitSourceClaim, assertSourceGate, invalidSourceReport, sourceReportRevision, submitUnboundSuccessor } from '../source-claims-model-fixture.js';
import { sourceClaimsAcceptance } from '../source-claims-acceptance.js';
import { persistTask, restoreTask } from '../../src/task.machine.js';
import type { SpecWorld } from './steps.js';

type Run = ReturnType<typeof sourceClaimsModel> & { missing?: string; integration?: Awaited<ReturnType<typeof sourceClaimsAcceptance>>; reply?: { ok: boolean; code: string } };
const runs = new WeakMap<SpecWorld, Run>();
const run = (world: SpecWorld) => runs.get(world)!;
Given('已保存文档D4的完整原文且其中写有进行中', function (this: SpecWorld) {
  runs.set(this, sourceClaimsModel());
});
When('负责人提交来源绑定D4且状态为进行中的工作项', async function (this: SpecWorld) {
  const f = run(this); assert(submitSourceClaim(f).ok); f.integration = await sourceClaimsAcceptance();
});
Then('应安排独立检查并由宿主生成文档编号', function (this: SpecWorld) {
  const f = run(this); assertSourceGate(f); assert(f.m.c.artifacts[0]!.content.includes('| D1 | doc-4 |'));
  assert(f.integration!.content.includes('| D1 | doc-4 |'));
});
Then('保存的工作项应保留原文档标识和回执标识', function (this: SpecWorld) {
  const f = run(this); assert.deepEqual(f.m.c.artifacts[0]!.sourceItems, [{ text: '安排评审', status: '进行中', sourceDocId: 'doc-4', sourceEvidenceId: 'op1' }]);
});
Given('同一批完整原文中D4写有待开始而D5写有进行中', function (this: SpecWorld) { runs.set(this, sourceClaimsModel('跨文档')); });
When('负责人把进行中状态绑定到D4后提交', function (this: SpecWorld) { assert(submitSourceClaim(run(this)).ok); });
Then(/^应在独立检查前拦截(SOURCE_[A-Z_]+)并保留缺口$/, function (this: SpecWorld, code: string) { assertSourceGate(run(this), code); });
Then('不应发起检查请求或把D5的状态移给D4', function (this: SpecWorld) {
  const f = run(this); assert.equal(f.m.c.usage.checks, 0); assert.equal(f.m.c.artifacts[0]!.sourceItems![0]!.sourceDocId, 'doc-4');
});
Given('工作项所引用的文档回执为{string}', function (this: SpecWorld, source: string) { runs.set(this, sourceClaimsModel(source)); });
When('负责人提交该文档进行中状态的工作项', function (this: SpecWorld) { assert(submitSourceClaim(run(this)).ok); });
Then('应在独立检查前拦截{string}并保留缺口', function (this: SpecWorld, code: string) { assertSourceGate(run(this), code); });
Given('负责人提交没有文档工作项的普通报告', function (this: SpecWorld) { runs.set(this, sourceClaimsModel()); });
When('系统预检该普通报告', function (this: SpecWorld) {
  const { m } = run(this); assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work,
    text: '普通报告', artifactIds: [], artifacts: [{ name: 'ordinary.md', content: '普通正文' }] }).ok);
});
Then('应沿用独立检查且报告正文保持原样', function (this: SpecWorld) { const f = run(this); assertSourceGate(f); assert.equal(f.m.c.artifacts[0]!.content, '普通正文'); });
Given('已保存带文档来源工作项的报告并恢复任务', function (this: SpecWorld) {
  const f = sourceReportRevision();
  f.m.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(f.m.snapshot)))); runs.set(this, f);
});
When('负责人引用该报告但原始回执已不可核实', function (this: SpecWorld) {
  const f = run(this), pending = f.m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(f.m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const owner = f.m.c.intents.find(work => work.id === pending.id)!;
  delete f.m.c.intents[0]!.localOperations![0]!.result!.data.stdout;
  assert(f.m.send({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt,
    text: '引用已有工作项报告', artifactIds: [f.m.c.artifacts[0]!.id] }).ok);
  assert.equal(f.m.c.intents.filter(work => work.kind === 'check').length, 1);
});
Given('工作项协议存在{string}', function (this: SpecWorld, field: string) { const f = sourceClaimsModel(); runs.set(this, { ...f, missing: field }); });
When('负责人提交该工作项报告', function (this: SpecWorld) {
  const f = run(this);
  f.reply = f.m.send({ type: 'DELIVER', workId: f.m.work.id, fence: f.m.work,
    text: '工作项报告', artifactIds: [], artifacts: [invalidSourceReport(f.missing!)] });
});
Then('应拒绝INVALID_REPORT且不生成候选或检查', function (this: SpecWorld) {
  const f = run(this); assert.equal(f.reply?.code, 'INVALID_REPORT'); assert.equal(f.m.c.candidate, null);
  assert.equal(f.m.c.intents.filter(work => work.kind === 'check').length, 0);
});

Given('当前报告已经保存来源工作项并等待负责人修订', function (this: SpecWorld) { runs.set(this, sourceReportRevision()); });
When('负责人替换该报告却遗漏工作项来源结构', function (this: SpecWorld) { submitUnboundSuccessor(run(this)); });
Then('不应发布去掉来源绑定的后继报告', function (this: SpecWorld) {
  assert.equal(run(this).m.c.publishedDelivery, undefined);
  assert.equal(run(this).m.c.usage.checks, 1);
});
