import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { judgmentsDiagnostic, type CheckMaterials } from '../../src/delivery-acceptance.js';
import { OpenAICompatibleAdapter, SqliteStore, WorkRunner } from '../../src/index.js';
import { candidateJudgments, Harness, saveEvidence } from '../helpers.js';
import { regenerationConfig, modelResponse } from '../model-regeneration-fixture.js';
import { verifyDeliveryDiagnosticModel } from '../delivery-diagnostics-model-fixture.js';
import type { SpecWorld } from './steps.js';

const original = '前言\n付款已经完成。\n资料结束';
const wrong = '付款已经全额完成。';
class DiagnosticFixture {
  directory = mkdtempSync(join(tmpdir(), 'squad-delivery-diagnostics-'));
  store = new SqliteStore(join(this.directory, 'state.sqlite'));
  h = new Harness(regenerationConfig(), this.store);
  requests: CheckMaterials[] = [];
  systems: string[] = [];
  sourceId: string;
  constructor() {
    const owner = this.h.claim('owner');
    this.sourceId = saveEvidence(this.h, owner, original);
    assert(this.h.event({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt, text: '已生成报告', artifactIds: [],
      artifacts: [{ name: 'report.md', content: '付款已经完成。' }] }).ok);
  }
  async run(quote: string, stop = false) {
    const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      this.requests.push(JSON.parse(body.messages[1].content).context);
      this.systems.push(body.messages[0].content);
      if (stop) assert(this.h.event({ type: 'STOP' }).ok);
      const results = candidateJudgments(this.h.context().candidate);
      return modelResponse({ type: 'check', criteriaResults: [{ ...results[0]!, source: { id: this.sourceId, quote } }, ...results.slice(1)] });
    } });
    assert(await new WorkRunner(this.h.engine, adapter, () => this.h.now).runOne(this.h.room, this.h.task));
  }
  get check() { return this.h.context().intents.find(work => work.kind === 'check')!; }
  close() { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
}
const fixtures = new WeakMap<SpecWorld, DiagnosticFixture>();
const fixture = (world: SpecWorld) => fixtures.get(world)!;
After(function (this: SpecWorld) { fixtures.get(this)?.close(); fixtures.delete(this); });

Given('候选与成功读取的来源已经固定', function (this: SpecWorld) {
  verifyDeliveryDiagnosticModel();
  fixtures.set(this, new DiagnosticFixture());
});
When('检查引用不是来源逐字原文并在补试前重启', async function (this: SpecWorld) {
  const f = fixture(this); await f.run(wrong); f.h.reopen();
});
Then('补试应收到原候选原来源和错误验收项的来源定位', async function (this: SpecWorld) {
  const f = fixture(this);
  const record = f.check.checkDiagnostics?.[0];
  assert.deepEqual(record?.diagnostic, { code: 'CHECK_SOURCE_QUOTE_MISMATCH', criterionId: candidateJudgments(f.h.context().candidate)[0]!.criterionId,
    sourceId: f.sourceId, quoteLength: 9, location: { field: 'stdout', offset: 3, matchedPrefixLength: 4 } });
  assert.equal(record?.candidateRevision, f.h.context().candidate!.revision);
  assert.equal(f.h.context().publishedDelivery, undefined);
});
Then('定位不得保存被拒绝的引文或未知来源编号', function (this: SpecWorld) {
  const f = fixture(this);
  assert(!JSON.stringify(f.check.checkDiagnostics).includes(wrong));
  const requirements = f.h.context().candidate!.acceptance!.criteria;
  const unknown = judgmentsDiagnostic(requirements, [{ criterionId: requirements[0]!.id, status: 'passed',
    source: { id: 'private-unknown-id', quote: 'private-rejected-body' } }], []);
  assert.deepEqual(unknown, { code: 'CHECK_SOURCE_NOT_FOUND', criterionId: requirements[0]!.id });
});
When('检查按定位提交逐字原文', async function (this: SpecWorld) { await fixture(this).run('付款已经完成。'); });
Then('候选应在独立检查通过后发布且只使用一次技术补试', function (this: SpecWorld) {
  const f = fixture(this), [first, second] = f.requests;
  assert(first && second);
  const { retryDiagnostic, ...retried } = second;
  assert.deepEqual(retried, first);
  assert.deepEqual(retryDiagnostic, f.check.checkDiagnostics?.[0]?.diagnostic);
  assert(f.systems[1]!.includes('context.retryDiagnostic'));
  assert.equal(f.h.context().outcome, 'complete');
  assert.equal(f.h.context().usage.checks, 2);
  assert.equal(f.h.context().usage.retries, 1);
});
When('两次检查均因引用不匹配而失败', async function (this: SpecWorld) {
  const f = fixture(this); await f.run(wrong); await f.run(wrong);
});
Then('已生成报告和成功读取回执应保留', function (this: SpecWorld) {
  const c = fixture(this).h.context();
  assert.equal(c.artifacts[0]?.content, '付款已经完成。');
  assert.equal(c.candidate?.text, '已生成报告');
  const operation = c.intents.flatMap(work => work.localOperations ?? []).find(op => op.id === fixture(this).sourceId)!;
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.result?.ok, true);
  assert.equal(operation.result?.data.stdout, original);
});
Then('结果应标为交付检查未完成且不得冒充工具调用失败或成功发布', function (this: SpecWorld) {
  const f = fixture(this), c = f.h.context();
  assert.equal(c.outcome, 'partial'); assert.equal(c.candidate?.deliveryIssue?.code, 'DELIVERY_CHECK_FAILED');
  assert.match(c.reason, /检查未完成/); assert.equal(c.publishedDelivery, undefined);
  assert.equal(f.check.checkDiagnostics?.length, 2); assert.equal(c.usage.checks, 2);
  assert.equal(f.h.engine.pending(f.h.room, f.h.task).length, 0);
});
When('检查在用户停止后返回引用错误', async function (this: SpecWorld) { await fixture(this).run(wrong, true); });
Then('不得保存旧诊断或安排补试或发布候选', function (this: SpecWorld) {
  const f = fixture(this), c = f.h.context();
  assert.equal(c.stopped, true); assert.equal(f.check.checkDiagnostics, undefined);
  assert.equal(c.deliveryCycle?.retry, undefined); assert.equal(c.publishedDelivery, undefined);
});
