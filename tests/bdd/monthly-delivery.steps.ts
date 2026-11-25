import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { InputIntentFixture, intentConfig, parsedIntent } from '../input-intent-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

const monthlyName = '2026-11-monthly-report.md';
const source = '# 业务进展\n\n完成 6 家试点。\n\n# 专项成果\n\n上线统一回执。\n\n# 附录\n\n原月报的其他内容。';
const request = `从上一轮 \`${monthlyName}\` 提炼「业务进展」和「专项成果」，排版从简。`;
const result = '## 业务进展\n\n完成 6 家试点。\n\n## 专项成果\n\n上线统一回执。';
const resultName = '月报提炼.md';
const runs = new WeakMap<SpecWorld, { fixture: InputIntentFixture; sourceId: string; sourceTaskId: string }>();

After(function (this: SpecWorld) { runs.get(this)?.fixture.close(); });

Given('群聊上一轮已发布一份包含业务进展和专项成果的月报', function (this: SpecWorld) {
  const fixture = new InputIntentFixture({ ...intentConfig(), deliveryReport: 'summary' }, true);
  const submitted = fixture.submit('整理十一月月报', { goal: { text: '整理十一月月报', constraints: [], criteria: [], requiredArtifacts: 1 } });
  assert(submitted.ok);
  assert(fixture.event({ type: 'DELIVER', text: '十一月月报已整理。', artifactIds: [], artifacts: [{ name: monthlyName, content: source }] }).ok);
  const context = fixture.context();
  assert.equal(context.outcome, 'complete');
  assert(context.publishedDelivery?.artifactIds[0]);
  runs.set(this, { fixture, sourceId: context.publishedDelivery.artifactIds[0], sourceTaskId: fixture.task });
});

When('用户明确从该月报提炼两节内容且负责人误将旧文件列为背景附件', async function (this: SpecWorld) {
  const { fixture, sourceId } = runs.get(this)!;
  assert(fixture.submit(request, { id: 'monthly-extraction' }).ok);
  fixture.response = work => {
    if (work.kind === 'interpretation') return modelResponse({ type: 'interpretation', spec: parsedIntent('request', {
      objective: '从十一月月报提炼业务进展和专项成果', constraints: ['排版从简'], expectedOutputs: [], acceptanceCriteria: [],
    }) });
    assert.equal(work.kind, 'owner');
    return modelResponse({ type: 'deliver', text: result, artifactIds: [], backgroundArtifactIds: [sourceId],
      artifacts: [{ name: resultName, content: result }] });
  };
  if (fixture.view().phase === 'interpreting') assert(await fixture.run());
  assert(await fixture.run());
});

Then('群聊应发布本轮提炼内容和新文件并固定原月报为来源', function (this: SpecWorld) {
  const { fixture, sourceId, sourceTaskId } = runs.get(this)!;
  fixture.reopen();
  const current = fixture.context();
  assert.equal(current.outcome, 'complete', current.reason);
  assert.partialDeepStrictEqual(current.sourceArtifact, { artifactId: sourceId, sourceTaskId, content: source });
  const file = current.artifacts.find(item => item.name === resultName);
  assert(file);
  assert.deepEqual(current.publishedDelivery?.artifactIds, [file.id]);
  assert.equal(file.content, result);
  assert.equal(current.candidate?.text, result);
  const previous = fixture.engine.view(fixture.room, sourceTaskId)?.context;
  assert.deepEqual(previous?.publishedDelivery?.artifactIds, [sourceId]);
  assert.equal(previous?.artifacts.find(item => item.id === sourceId)?.content, source);
});

Then('群消息不应为清理旧附件引用显示验收失败', function (this: SpecWorld) {
  const { fixture } = runs.get(this)!;
  const context = fixture.context();
  assert.equal(context.intents.filter(work => work.kind === 'check').length, 0);
  const messages = context.messages.filter(message => message.kind !== 'user');
  assert(messages.some(message => message.kind === 'final' && message.artifactIds?.length === 1));
  assert.doesNotMatch(messages.map(message => message.detailText ?? message.text).join('\n'), /INVALID_BACKGROUND_ARTIFACT|不属于当前目标|待确认|验收失败/);
});
