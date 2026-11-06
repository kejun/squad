import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { InputIntentFixture } from '../input-intent-fixture.js';
import type { SpecWorld } from './steps.js';
const fixtures = new WeakMap<SpecWorld, InputIntentFixture>();
const request = '请修订采购报告；保留原有成本数字；删除降低硬约束的建议，并重新交付报告。';
Given('用户要求修订采购报告但未指定内部产物字段', function (this: SpecWorld) {
  const fixture = new InputIntentFixture(); fixtures.set(this, fixture);
  assert(fixture.submit(request).ok);
});
When('输入解释器解析这条直接用户请求', async function (this: SpecWorld) {
  await fixtures.get(this)!.run();
  assert.equal(fixtures.get(this)!.view().phase, 'running');
});
Then('解释上下文应保留原始要求且不包含产物修订执行指令', function (this: SpecWorld) {
  const parsed = fixtures.get(this)!.requests[0]!;
  assert.equal(parsed.kind, 'interpretation');
  assert(JSON.stringify(parsed.context).includes(request));
  assert(!parsed.messages[0]!.content.includes('replacesArtifactId'));
  assert(!parsed.messages[0]!.content.includes('Create reports in artifacts'));
});
Then('负责人仍应收到产物修订执行指令', async function (this: SpecWorld) {
  const fixture = fixtures.get(this)!; await fixture.run();
  const owner = fixture.requests[1]!; assert.equal(owner.kind, 'owner');
  assert(owner.messages[0]!.content.includes('replacesArtifactId'));
});
After(function (this: SpecWorld) { fixtures.get(this)?.close(); fixtures.delete(this); });
