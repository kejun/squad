import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { InputIntentFixture, parsedIntent } from '../input-intent-fixture.js';
import { documentUrls, groupedIntent } from '../map-capacity-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';

const website = parsedIntent('request', {
  objective: '创建单页个人网站',
  constraints: ['仅交付单个 HTML 文件'],
  expectedOutputs: ['index.html'],
  acceptanceCriteria: ['包含简介与联系方式', '支持键盘操作'],
});
const batch = groupedIntent(2);
const shortMaterials = parsedIntent('request', {
  objective: '逐份核对八条简短公告的发布日期',
  constraints: ['对八条公告使用同一日期核对口径'],
  expectedOutputs: ['逐项日期与出处'],
  acceptanceCriteria: ['每条公告有单独结果和出处'],
  decomposition: {
    ...batch.decomposition!,
    synthesis: '汇总八条公告的逐项日期与出处。',
    partitions: batch.decomposition!.partitions.map(part => ({
      ...part,
      objective: part.objective.replace('研究以下来源', '按同一日期规则核对以下短公告'),
      expectedOutput: '为每条公告分别回交日期和原始出处。',
    })),
  },
});
const tasks = new Map([
  ['单页网站', '创建单页个人网站；仅交付单个 HTML 文件 index.html；包含简介与联系方式，支持键盘操作。'],
  ['八份同类短材料', `逐份核对以下八条简短公告的发布日期；使用同一日期核对口径；每条保留独立结果和出处。\n${documentUrls.join('\n')}`],
]);
const plans = new Map([['主笔直达', website], ['组合轻量核对', shortMaterials]]);
const fixtures = new WeakMap<SpecWorld, InputIntentFixture>();
const fixture = (world: SpecWorld) => fixtures.get(world)!;

After(function (this: SpecWorld) { fixtures.get(this)?.close(); });

Given('用户提交需要理解的「{word}」且分片资源充足', function (this: SpecWorld, task: string) {
  const request = tasks.get(task);
  assert(request, `未知任务样例 ${task}`);
  const run = new InputIntentFixture();
  fixtures.set(this, run);
  assert(run.submit(request).ok);
});

When('宿主在一次理解请求中取得「{word}」', async function (this: SpecWorld, plan: string) {
  const run = fixture(this);
  const spec = plans.get(plan);
  assert(spec, `未知计划样例 ${plan}`);
  run.response = () => modelResponse({ type: 'interpretation', spec });
  assert(await run.run());
  assert.deepEqual(run.requests.map(request => request.kind), ['interpretation']);
  assert.deepEqual(run.context().inputAnalyses?.at(-1)?.spec, spec);
});

Then('模型应收到比较工作量可用并发和分工开销的指引', function (this: SpecWorld) {
  const [request] = fixture(this).requests;
  assert.equal(request!.context.maxPartitions, 8);
  assert.equal(request!.context.maxConcurrentPartitions, 4);
  const prompt = request!.messages[0]!.content;
  assert.match(prompt, /compare.+workload.+available concurrency.+repeated context.+synthesis/i);
  assert.match(prompt, /small deliverable.+brief checks.+omit decomposition/i);
  assert.match(prompt, /group.+same short check.+each source separately traceable/i);
});

Then('宿主应保留全部要求并按计划派发「一次主笔工作」', function (this: SpecWorld) {
  const run = fixture(this);
  const [work, ...extra] = run.engine.pending(run.room, run.task);
  assert.deepEqual([work?.kind, work?.target, extra.length], ['owner', 'A', 0]);
  assert.deepEqual((work!.payload.inputIntents as { spec: unknown }[]).at(-1)?.spec, website);
});

Then('宿主应保留全部要求并按计划派发「两个逐份保留出处的分片」', function (this: SpecWorld) {
  const run = fixture(this);
  const pending = run.engine.pending(run.room, run.task);
  assert.deepEqual(pending.map(work => work.kind), ['assistance', 'assistance']);
  assert.equal(new Set(pending.map(work => work.target)).size, 2);
  const partitions = pending.map(work => work.payload.partition as { objective: string; expectedOutput: string });
  const sources = partitions.flatMap(part => part.objective.match(/https:\/\/docs\.fixture\.example\/doc-\d\.md/g) ?? []);
  assert.deepEqual(sources.sort(), [...documentUrls].sort());
  assert.deepEqual(partitions, shortMaterials.decomposition!.partitions);
  assert.deepEqual((pending[0]!.payload.inputIntents as { spec: unknown }[]).at(-1)?.spec, shortMaterials);
});
