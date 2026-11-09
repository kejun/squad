import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { InputIntentFixture, parsedIntent } from '../input-intent-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { AcceptanceCriterion, CheckMaterials } from '../../src/delivery-acceptance.js';
import type { SpecWorld } from './steps.js';
const raw = '请分别核对完整数据1和2并给出合计。全部输入已给出，无需网络、技能或CLI。禁止向外部发送消息或修改外部资源。';
const strictConstraints = ['必须离线处理', '不得访问网络', '禁止向外部发送消息', '禁止修改外部资源', '必须提供执行审计证据'];
const strictRaw = `请分别核对完整数据1和2并给出合计。数据齐备，无需工具。${strictConstraints.join('；')}。`;
const runs = new WeakMap<SpecWorld, InputIntentFixture>();
Given('用户提供完整数据并说明无需工具且禁止外部写入', function (this: SpecWorld) {
  const f = new InputIntentFixture(); runs.set(this, f); assert(f.submit(raw).ok);
  f.replies = [{ type: 'interpretation', spec: parsedIntent('request', { objective: '核对合计',
    constraints: ['禁止向外部发送消息或修改外部资源'], expectedOutputs: ['合计'], acceptanceCriteria: ['合计为3', '证明没有调用工具'] }) }];
});
Given('用户明确要求离线处理并禁止联网发送和外部写入且要求审计证据', function (this: SpecWorld) {
  const f = new InputIntentFixture(); runs.set(this, f); assert(f.submit(strictRaw).ok);
  f.response = request => request.kind === 'interpretation'
    ? modelResponse({ type: 'interpretation', spec: parsedIntent('request', { objective: '离线核对合计',
      constraints: strictConstraints, expectedOutputs: ['合计和审计证据'], acceptanceCriteria: ['合计为3'] }) })
    : request.kind === 'check'
      ? modelResponse({ type: 'check', criteriaResults: (request.context.requirements as AcceptanceCriterion[]).map(item =>
        item.text === '必须提供执行审计证据' ? { criterionId: item.id, status: 'unverified', reason: '没有所要求的审计证据' }
          : { criterionId: item.id, status: 'passed' }) })
      : modelResponse({ type: 'answer', text: '合计3，未提供审计证据' });
});
When('输入解释与交付检查处理这份原始要求', async function (this: SpecWorld) {
  const f = runs.get(this)!; await f.run(); await f.run(); await f.run();
  assert.deepEqual(f.requests.map(r => r.kind), ['interpretation', 'owner', 'check']);
});
Then('解释与检查均应区分无需工具的说明和明确禁止条件', function (this: SpecWorld) {
  const f = runs.get(this)!;
  for (const kind of ['interpretation', 'check']) {
    const instructions = f.requests.find(r => r.kind === kind)!.messages[0]!.content;
    assert(instructions.includes('no need to use tools'));
    assert(instructions.includes('not a prohibition or a request for evidence of non-use'));
    assert(instructions.includes('Preserve and enforce explicit prohibitions'));
  }
});
Then('检查应依据冻结原文处理被解释加强的条件而保留全部明确禁令', function (this: SpecWorld) {
  const request = runs.get(this)!.requests.find(r => r.kind === 'check')!;
  const materials = request.context as unknown as CheckMaterials;
  assert(materials.rawInputs.some(input => input.text === raw));
  assert(materials.requirements.some(item => item.text === '证明没有调用工具'));
  assert(request.messages[0]!.content.includes('assess the original requirement under the same criterion ID'));
  assert(request.messages[0]!.content.includes('explicitly requested audit evidence'));
});
Then('明确禁令和必须提供的审计证据应保留在冻结要求中', function (this: SpecWorld) {
  const f = runs.get(this)!, request = f.requests.find(r => r.kind === 'check')!;
  const materials = request.context as unknown as CheckMaterials;
  assert(materials.rawInputs.some(input => input.text === strictRaw));
  for (const constraint of strictConstraints) assert(materials.requirements.some(item => item.text === constraint));
  for (const kind of ['interpretation', 'check']) {
    const prompt = f.requests.find(r => r.kind === kind)!.messages[0]!.content;
    assert(prompt.includes('Preserve and enforce explicit prohibitions'));
    assert(prompt.includes('explicitly requested audit evidence'));
  }
});
Then('缺少用户明确要求的审计证据时不得完整交付', function (this: SpecWorld) {
  const context = runs.get(this)!.context();
  assert.equal(context.outcome, 'partial');
  assert.equal(context.publishedDelivery, undefined);
  assert(context.reason.includes('没有所要求的审计证据'));
});
After(function (this: SpecWorld) { runs.get(this)?.close(); runs.delete(this); });
