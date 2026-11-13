import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { judgmentsDiagnostic, type CheckMaterials } from '../../src/delivery-acceptance.js';
import { OpenAICompatibleAdapter, SqliteStore, WorkRunner } from '../../src/index.js';
import { candidateJudgments, Harness, saveEvidence } from '../helpers.js';
import { regenerationConfig, modelResponse } from '../model-regeneration-fixture.js';
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
  fixtures.set(this, new DiagnosticFixture());
});
When('检查员通过候选但引用采用非逐字表述并恢复任务', async function(this:SpecWorld) { const f=fixture(this);await f.run(wrong);f.h.reopen(); });
Then('应保留原始材料和下游通过结论且不产生引用补试',function(this:SpecWorld){const f=fixture(this);assert.equal(f.h.context().outcome,'complete');assert.equal(f.requests.length,1);assert.equal(f.h.context().usage.retries,0);assert.equal(f.check.checkDiagnostics,undefined);});
When('检查员通过候选但可选来源编号未在目录中',async function(this:SpecWorld){const f=fixture(this);f.sourceId='not-in-catalog';await f.run(wrong);});
Then('应保留来源真实回执并采用一次检查结论',function(this:SpecWorld){const f=fixture(this);assert.equal(f.requests.length,1);assert.equal(f.h.context().outcome,'complete');assert(f.h.context().intents.some(w=>w.localOperations?.some(op=>op.status==='succeeded')));});
When('检查在用户停止后返回引用错误', async function (this: SpecWorld) { await fixture(this).run(wrong, true); });
Then('不得保存旧诊断或安排补试或发布候选', function (this: SpecWorld) {
  const f = fixture(this), c = f.h.context();
  assert.equal(c.stopped, true); assert.equal(f.check.checkDiagnostics, undefined);
  assert.equal(c.deliveryCycle?.retry, undefined); assert.equal(c.publishedDelivery, undefined);
});
