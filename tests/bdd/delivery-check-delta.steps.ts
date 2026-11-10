import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter, WorkRunner } from '../../src/index.js';
import type { CheckMaterials } from '../../src/delivery-acceptance.js';
import type { Candidate, TaskContext } from '../../src/types.js';
import { candidateJudgments, Harness, saveEvidence } from '../helpers.js';
import { modelResponse, regenerationConfig } from '../model-regeneration-fixture.js';
import { originalEvidence, originalReport, revisedReport, regressedReport, removedRequirement } from '../delivery-check-delta-fixture.js';
import type { SpecWorld } from './steps.js';

class DeltaFixture {
  h = new Harness(regenerationConfig({ checks: 5, ordinary: 30 }));
  requests: CheckMaterials[] = [];
  systems: string[] = [];
  mode: 'pass' | 'missing' | 'technical' | 'regression' = 'pass';
  sourceId: string;
  constructor() {
    const work = this.h.claim('owner'); this.sourceId = saveEvidence(this.h, work, originalEvidence);
    assert(this.h.event({ type: 'DELIVER', workId: work.id, fence: work, attempt: work.attempt,
      text: '报告', artifactIds: [], artifacts: [{ name: 'report.md', content: originalReport }] }).ok);
  }
  async run() {
    const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const material = JSON.parse(body.messages[1].content).context as CheckMaterials;
      this.systems.push(body.messages[0].content); this.requests.push(material);
      if (this.mode === 'technical') return Response.json({ error: { code: 'temporary' } }, { status: 503 });
      const results = candidateJudgments(this.h.context().candidate);
      if (this.requests.length === 1) results[0] = { ...results[0]!, status: 'failed', reason: '付款状态有误', source: { id: this.sourceId, quote: '付款已经完成。' } };
      if (this.mode === 'regression') results[1] = { ...results[1]!, status: 'failed', reason: '修订删除了原来通过的验收内容' };
      return modelResponse({ type: 'check', criteriaResults: this.mode === 'missing' ? results.slice(0, 1) : results });
    } });
    assert(await new WorkRunner(this.h.engine, adapter, () => this.h.now).runOne(this.h.room, this.h.task));
  }
  revise(content = revisedReport) {
    const work = this.h.claim('owner'), artifact = this.h.context().artifacts[0]!;
    assert(this.h.event({ type: 'DELIVER', workId: work.id, fence: work, attempt: work.attempt,
      text: '报告', artifactIds: [], artifacts: [{ name: 'report.md', content, replacesArtifactId: artifact.id }] }).ok);
  }
  mutate(update: (context: TaskContext) => void) {
    this.h.store.transact(this.h.room, tx => update((tx.room.tasks[this.h.task] as { snapshot: { context: TaskContext } }).snapshot.context));
    this.h.reopen();
  }
}
const fixtures = new WeakMap<SpecWorld, DeltaFixture>();
const fixture = (world: SpecWorld) => fixtures.get(world)!;
Given('已检查的长报告只有一项有逐字来源的缺口', async function (this: SpecWorld) {
  const f = new DeltaFixture(); fixtures.set(this, f); await f.run();
  assert.equal(f.requests[0]?.delta, undefined); assert.equal(f.h.context().outcome, null);
});
When('负责人用该来源原文修复报告并提交新版本', function (this: SpecWorld) { fixture(this).revise(); });
Then('复核应收到全部前轮判断和要求以及完整候选差异', async function (this: SpecWorld) {
  const f = fixture(this); await f.run(); const material = f.requests[1]!;
  assert(material.delta); assert.equal(material.delta.previousResults.length, material.requirements.length);
  assert.deepEqual(material.requirements, f.requests[0]!.requirements);
  assert.equal(material.delta.artifacts[0]?.change.removed, '尚未'); assert.equal(material.delta.artifacts[0]?.change.added, '已经');
  assert(f.systems[1]?.includes('You must still return every requirement ID exactly once'));
  assert.equal(f.h.context().outcome, 'complete');
});
Then('不应重复发送未修改的报告正文和无关来源全文', function (this: SpecWorld) {
  const f = fixture(this), material = f.requests[1]!;
  assert.equal(material.artifacts.length, 0); assert.equal(material.candidate.text, '');
  assert(material.evidence[0]?.stdout?.includes('付款已经完成。'));
  assert.equal(material.delta?.sources[0]?.id, f.sourceId);
  assert(JSON.stringify(material).length < JSON.stringify(f.requests[0]).length / 4);
  assert.equal(f.h.context().artifacts.at(-1)?.content, revisedReport);
});
When('负责人在修复中新增其他事实', function (this: SpecWorld) { fixture(this).revise(revisedReport + '\n另外已经完成发货。'); });
Then('复核应收到完整候选和固定证据而不是不完整的增量', async function (this: SpecWorld) {
  const f = fixture(this); await f.run(); const material = f.requests[1]!;
  assert.equal(material.delta, undefined); assert.equal(material.evidence[0]?.stdout, originalEvidence);
  assert(material.artifacts.some(item => !item.background && item.content.startsWith(originalReport.slice(0, 1000))));
});
When('修订提交时检查基线出现{string}', function (this: SpecWorld, boundary: string) {
  const f = fixture(this);
  f.mutate(c => {
    const check = c.intents.find(item => item.kind === 'check')!;
    if (boundary === '缺少检查结果') delete check.criteriaResults;
    if (boundary === '属于其他轮次') check.epoch--;
    if (boundary === '来源无法定位') delete check.criteriaResults![0]!.source;
    if (boundary === '原始要求变化') (check.payload.candidate as Candidate).acceptance!.criteria[0]!.text = '旧要求';
  });
  f.revise();
});
When('复核只回答原来失败的要求', async function (this: SpecWorld) { const f = fixture(this); f.mode = 'missing'; await f.run(); });
Then('应拒绝不完整复核且不得继承旧通过判断发布候选', function (this: SpecWorld) {
  const f = fixture(this), c = f.h.context(); assert(f.requests[1]?.delta);
  assert.equal(c.publishedDelivery, undefined); assert.notEqual(c.outcome, 'complete');
  const check = c.intents.filter(item => item.kind === 'check').at(-1)!; assert.equal(check.status, 'pending');
  assert.equal(check.criteriaResults, undefined); assert.equal(c.usage.retries, 1);
});
When('固定来源的捕获哈希发生变化', function (this: SpecWorld) {
  const f = fixture(this); f.mutate(c => {
    const source = c.intents.flatMap(item => item.localOperations ?? []).find(item => item.id === f.sourceId)!;
    (source.result!.data.capturedEvidence as { stdout: { capturedContentHash: string } }).stdout.capturedContentHash = 'b'.repeat(64);
  });
});
Then('应阻止检查且不得发布候选', async function (this: SpecWorld) {
  const f = fixture(this); await f.run(); assert.equal(f.requests.length, 1);
  assert.equal(f.h.context().publishedDelivery, undefined); assert.notEqual(f.h.context().outcome, 'complete');
  assert.match(f.h.context().candidate?.deliveryIssue?.code ?? f.h.context().reason, /CHECK_EVIDENCE_CHANGED|DELIVERY_CHECK_FAILED/);
});
When('检查因技术错误补试并重启', async function (this: SpecWorld) {
  const f = fixture(this); f.mode = 'technical'; await f.run(); f.h.reopen(); f.mode = 'pass';
});
Then('补试应使用同一基线和相同差异且全部要求通过后才发布', async function (this: SpecWorld) {
  const f = fixture(this); assert(f.requests[1]?.delta); assert.equal(f.h.context().publishedDelivery, undefined);
  await f.run(); assert.deepEqual(f.requests[2], f.requests[1]); assert.equal(f.h.context().outcome, 'complete');
  assert.equal(f.h.context().usage.retries, 1); assert.equal(f.h.context().usage.checks, 3);
});

When('负责人修复缺口却删除原来通过的验收内容', function (this: SpecWorld) { fixture(this).revise(regressedReport); });
When('复核确认原缺口已修复但指出被删除内容的要求失败', async function (this: SpecWorld) {
  const f = fixture(this); f.mode = 'regression'; await f.run();
});
Then('增量应包含完整删除且新失败判断应保留而不能发布', function (this: SpecWorld) {
  const f = fixture(this), c = f.h.context();
  assert(f.requests[1]?.delta?.artifacts[0]?.change.removed.includes(removedRequirement));
  const check = c.intents.filter(item => item.kind === 'check').at(-1)!;
  assert.equal(check.criteriaResults?.[0]?.status, 'passed'); assert.equal(check.criteriaResults?.[1]?.status, 'failed');
  assert.equal(check.criteriaResults?.[1]?.reason, '修订删除了原来通过的验收内容');
  assert.equal(c.publishedDelivery, undefined); assert.notEqual(c.outcome, 'complete');
  assert(c.intents.some(item => item.kind === 'owner' && item.payload.deliveryRevision && item.status === 'pending'));
});
