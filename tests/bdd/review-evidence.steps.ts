import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { Harness, candidateJudgments } from '../helpers.js';
import { regenerationConfig, modelResponse } from '../model-regeneration-fixture.js';
import { OpenAICompatibleAdapter, WorkRunner } from '../../src/index.js';
import type { checkModelInput } from '../../src/check-model-input.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, { h: Harness; materials?: ReturnType<typeof checkModelInput>; instructions?: string; page?: string }>();
Given('当前目标已保存成员对完整草稿的审查请求和独立答复', function (this: SpecWorld) {
  const h = new Harness(regenerationConfig()); runs.set(this, { h });
  h.help('old-request'); h.result('old-result', 'old-request');
  assert(h.event({ type: 'USER_INPUT', text: '新目标', goal: { text: '需独立审查', constraints: [], criteria: ['提交完整审查记录'], requiredArtifacts: 0 } }).ok);
  assert(h.event({ type: 'HELP', caller: 'A', requestId: 'current-review', target: 'B', question: '完整JSON与报告：金额100', expected: '核对完整草稿' }).ok);
  assert(h.event({ type: 'HELP_RESULT', requestId: 'current-review', resultId: 'current-result', status: 'success', answer: '独立审查完成；金额100一致' }).ok);
});
When('负责人提交经过该审查的交付', async function (this: SpecWorld) {
  const run = runs.get(this)!; const { h } = run;
  assert(h.event({ type: 'DELIVER', text: '金额100，已审查', artifactIds: [] }).ok);
  assert.equal(h.context().outcome, null);
  const adapter = new OpenAICompatibleAdapter(h.config, { env: {}, clock: () => h.now, transport: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!run.materials) {
      run.materials = JSON.parse(body.messages[1].content).context; run.instructions = body.messages[0].content;
      return modelResponse({ type: 'readCheckSource', sourceId: 'current-result' });
    }
    run.page = JSON.parse(body.messages.at(-1).content).data.text;
    return modelResponse({ type: 'check', criteriaResults: candidateJudgments(h.context().candidate).map(item => ({ ...item, source: { id: 'current-result', quote: '独立审查完成；金额100一致' } })) });
  } });
  await new WorkRunner(h.engine, adapter, () => h.now).runOne(h.room, h.task);
});
Then('独立检查应能按冻结引用读取审查请求与答复并逐字引用', function (this: SpecWorld) {
  const run = runs.get(this)!;
  assert(!JSON.stringify(run.materials).includes('独立审查完成；金额100一致'));
  assert.deepEqual(JSON.parse(run.page!), { requestId: 'current-review', member: 'B', status: 'success', goalVersion: 2, epoch: 1,
    question: '完整JSON与报告：金额100', expected: '核对完整草稿', answer: '独立审查完成；金额100一致', artifacts: [] });
  assert.equal(run.h.context().outcome, 'complete');
});
Then('审查记录只证明审查过程而不自动证明交付通过', function (this: SpecWorld) {
  assert(runs.get(this)!.instructions?.includes('Review records prove what was requested and answered, not that the answer is correct'));
});
Then('旧目标或未完成的协作不得冒充当前审查证据', function (this: SpecWorld) {
  const records = runs.get(this)!.materials!.sourceIndex;
  assert.deepEqual(records.filter(record => record.kind === 'review').map(record => record.id), ['current-result']);
  assert(!JSON.stringify(records).includes('old-result'));
});
After(function (this: SpecWorld) { runs.get(this)?.h.store.close(); runs.delete(this); });
