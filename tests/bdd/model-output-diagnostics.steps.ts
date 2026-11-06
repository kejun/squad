import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { RegenerationFixture, modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, RegenerationFixture>();
Given('负责人只创建新产物但漏写交付引用数组', function (this: SpecWorld) {
  const f = new RegenerationFixture('owner'); runs.set(this, f);
  f.replies = [{ type: 'deliver', text: 'private-invalid-body-marker', artifacts: [{ name: 'report.md', content: 'report' }] },
    { type: 'deliver', text: 'complete', artifactIds: [], artifacts: [{ name: 'report.md', content: 'report' }] }];
});
When('执行字段诊断交付', async function (this: SpecWorld) { await runs.get(this)!.run(); });
Then('修复反馈应说明必须提供引用数组且新产物可使用空数组', function (this: SpecWorld) {
  const f = runs.get(this)!;
  const feedback = JSON.parse(f.requests[1]!.messages.at(-1)!.content);
  assert.equal(feedback.fieldRequirements.artifactIds, 'Required array of existing artifact IDs. Use [] when all deliverables are new drafts.');
});
Then('修复不得回显无效正文或自动补齐缺失字段', function (this: SpecWorld) {
  const f = runs.get(this)!;
  assert.equal(f.requests.length, 2);
  assert(!JSON.stringify(f.requests[1]).includes('private-invalid-body-marker'));
  assert(!JSON.stringify(f.h.context()).includes('private-invalid-body-marker'));
});
Then('合法修复只发布一个候选并消耗一次重试额度', function (this: SpecWorld) {
  const f = runs.get(this)!;
  assert.equal(f.h.view().phase, 'checking');
  assert.equal(f.h.context().artifacts.filter(a => a.name === 'report.md').length, 1);
  assert.equal(f.h.context().usage.retries, 1);
});
Given('交付检查的模型响应因输出长度上限而截断', function (this: SpecWorld) {
  const f = new RegenerationFixture('check'); runs.set(this, f);
  f.responseFactory = () => modelResponse('private-truncated-body-marker', 'length');
});
When('执行容量受限的交付检查', async function (this: SpecWorld) { await runs.get(this)!.run(); });
Then('应报告明确输出容量失败且保留未完成状态', function (this: SpecWorld) {
  const f = runs.get(this)!;
  assert.equal(f.h.context().outcome, 'partial');
  assert(f.h.context().reason.includes('CHECK_OUTPUT_LIMIT'));
});
Then('不得再次调用同一容量的模型或接受截断内容', async function (this: SpecWorld) {
  const f = runs.get(this)!; await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.h.context().usage.retries, 0);
  assert(!JSON.stringify(f.h.context()).includes('private-truncated-body-marker'));
});
After(function (this: SpecWorld) { runs.get(this)?.close(); runs.delete(this); });
