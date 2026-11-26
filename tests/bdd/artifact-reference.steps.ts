import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { MemoryStore, OpenAICompatibleAdapter, TeamEngine, WorkRunner } from '../../src/index.js';
import type { CommandResult } from '../../src/engine.js';
import type { ArtifactReference } from '../../src/types.js';
import type { SpecWorld } from './steps.js';
import {
  cleanupReferenceFixtures, verifyRevisionIsolation, prepareSourceAmbiguity,
  verifySourceRejections, verifyReferenceBusy, verifyReferenceControls,
  verifySourceBeyondHistory, verifyReferenceReplay, verifyReferenceRollback,
  verifyReferenceRecovery, verifyLegacyPublication, publish,
} from '../artifact-reference-fixture.js';
import { verifyRevisionCandidate, verifyStoppedRevision, verifyFixedSourceExecution, verifyExplicitPublicationAuthority } from '../artifact-reference-model-fixture.js';
import { verifyReferenceConcurrency } from '../artifact-reference-http-fixture.js';
import { verifyArtifactSourceComposer } from '../artifact-source-ui-fixture.js';
import { configuration, passFixtureCheck } from '../helpers.js';
import { modelResponse } from '../model-regeneration-fixture.js';

interface ReferenceState { variant?: string; verified?: boolean; disposition?: string; select?: () => void }
const states = new WeakMap<SpecWorld, ReferenceState>();
function state(world: SpecWorld) {
  let current = states.get(world); if (!current) { current = {}; states.set(world, current); }
  return current;
}
After(function () { cleanupReferenceFixtures(); });
Given('同群 A 已成功发布唯一的 a.md', function (this: SpecWorld) { state(this); });
When('用户发送修改 a.md 补充部署说明并输出 b.md', function (this: SpecWorld) {
  verifyRevisionIsolation(); state(this).verified = true;
});
Then('应创建由 A 负责的新任务并完整固定 a.md 原文', function (this: SpecWorld) { assert(state(this).verified); });
Then('新文档通过独立检查后才发布且来源可定位原产物', function (this: SpecWorld) { assert(state(this).verified); });
Then('原任务快照历史发布清单和下载正文保持原样', function (this: SpecWorld) { assert(state(this).verified); });
Given('同群有两个成功发布的同名 Markdown', function (this: SpecWorld) { state(this); });
When('用户按文件名请求修改', function (this: SpecWorld) { state(this).select = prepareSourceAmbiguity().select; state(this).verified = true; });
Then('应返回含任务负责人交付时间的候选且不创建或补充任务', function (this: SpecWorld) { assert(state(this).verified); });
When('用户选定一个来源并直接点名现有成员', function (this: SpecWorld) { const select = state(this).select; assert(select); select(); });
Then('应固定所选原文并由点名成员负责', function (this: SpecWorld) { assert(state(this).verified); });
Given('用户选择的来源为{string}', function (this: SpecWorld, variant: string) { state(this).variant = variant; });
When('用户请求引用到新任务', function (this: SpecWorld) { verifySourceRejections(state(this).variant!); state(this).verified = true; });
Then('应明确拒绝且不创建任务或派发工作', function (this: SpecWorld) { assert(state(this).verified); });
Then('存在显式发布记录时不能回退到更早的最终消息', function () { assert.equal(verifyExplicitPublicationAuthority().status, 'passed'); });
Given('群内存在已发布的 a.md', function (this: SpecWorld) { state(this); });
When('用户发送{string}', function (this: SpecWorld, input: string) { verifyReferenceControls(input); state(this).verified = true; });
Then('不应从这条输入创建产物修订任务', function (this: SpecWorld) { assert(state(this).verified); });
Given('群处于{string}', function (this: SpecWorld, variant: string) { state(this).variant = variant; });
When('用户提交明确的产物修订请求', function (this: SpecWorld) { verifyReferenceBusy(state(this).variant!); state(this).verified = true; });
Then('应拒绝本次请求并保留原任务状态消息和工作意图', function (this: SpecWorld) { assert(state(this).verified); });
Given('新任务已固定超出群历史窗口的来源原文', function (this: SpecWorld) { state(this); });
When('历史刷新源任务发布新修订并且服务重启', function (this: SpecWorld) { verifySourceBeyondHistory(); verifyFixedSourceExecution(); state(this).verified = true; });
Then('新任务负责人协作者和独立检查仍取得同一完整原文和用户要求', function (this: SpecWorld) { assert(state(this).verified); });
Then('原文中的伪指令没有调度权限且不作为本轮产物', function (this: SpecWorld) { assert(state(this).verified); });
Given('新任务已固定一份来源原文', function (this: SpecWorld) { state(this); });
When('模型提交{string}', function (this: SpecWorld, candidate: string) { state(this).disposition = verifyRevisionCandidate(candidate); });
Then('引用任务应{string}且不改变来源任务', function (this: SpecWorld, disposition: string) { assert.equal(state(this).disposition, disposition); });
Given('已有合格来源和一个修订请求', function (this: SpecWorld) { state(this); });
When('同请求重放更改载荷并发提交或事务回滚发生', async function (this: SpecWorld) {
  await verifyReferenceConcurrency(); verifyReferenceReplay(); verifyReferenceRollback('memory'); verifyReferenceRollback('sqlite'); verifyReferenceRecovery(); state(this).verified = true;
});
Then('相同载荷只创建一个任务且变更载荷复用标识被拒绝', function (this: SpecWorld) { assert(state(this).verified); });
Then('未提交任务不会执行且来源任务不变', function (this: SpecWorld) { assert(state(this).verified); });
Given('引用任务已领取负责人工作', function (this: SpecWorld) { state(this); });
When('用户停止任务后旧结果返回', function (this: SpecWorld) { verifyStoppedRevision(); state(this).verified = true; });
Then('不应发布成功修订且固定来源与原任务均保持原样', function (this: SpecWorld) { assert(state(this).verified); });
Given('用户预览当前群成功发布的Markdown', function (this: SpecWorld) { state(this); });
When('用户引用到新任务并编辑或移除引用', async function (this: SpecWorld) { await verifyArtifactSourceComposer(); state(this).verified = true; });
Then('输入区应展示可移除的来源且请求只携带来源身份', function (this: SpecWorld) { assert(state(this).verified); });
Then('忙碌拒绝保留输入和引用并允许以新请求标识重发', function (this: SpecWorld) { assert(state(this).verified); });
Given('来源来自可确认发布的旧快照', function (this: SpecWorld) { state(this); });
When('用户修订并再次从新文档发起任务', function (this: SpecWorld) { verifyLegacyPublication(); state(this).verified = true; });
Then('每个任务应只指向自己的直接来源且无引用旧快照行为不变', function (this: SpecWorld) { assert(state(this).verified); });

const monthlyName = '2026-11-monthly-report.md';
const monthlyText = '# 月报\n\n## 业务进展\n完成首批交付。\n\n## 专项成果\n验证自动导出。\n\n## 其他\n另行安排。';
const extractText = '## 业务进展\n完成首批交付。\n\n## 专项成果\n验证自动导出。';
type MonthlyState = { store: MemoryStore; engine: TeamEngine; original?: ArtifactReference;
  earlier?: ReturnType<MemoryStore['read']>; submitted?: CommandResult };
const monthly = new WeakMap<SpecWorld, MonthlyState>();

function monthlyRoom(world: SpecWorld) {
  const store = new MemoryStore(), config = configuration();
  config.models = { default: 'fixture', services: { fixture: { baseUrl: 'https://model.example/v1', model: 'fixture' } } };
  config.inputAnalysis = { enabled: true };
  const engine = new TeamEngine(store, config, () => 10);
  const run: MonthlyState = { store, engine };
  monthly.set(world, run);
  return run;
}

Given('本群已成功发布名为{string}的月报', function (this: SpecWorld, name: string) {
  const run = monthlyRoom(this);
  run.original = publish(run.engine, 'monthly', name, monthlyText);
});

Given('本群也已成功发布内容不同的 a.md', function (this: SpecWorld) {
  publish(monthly.get(this)!.engine, 'shorter-source', 'a.md', '# 另一份报告');
});

Given('明确指定的月报来源为{string}', function (this: SpecWorld, condition: string) {
  const { engine } = monthlyRoom(this);
  if (condition === '本群两份同名当前交付') {
    publish(engine, 'monthly', monthlyName, monthlyText);
    publish(engine, 'other-monthly', monthlyName, '# 另一份月报');
  } else if (condition === '只有其他群的同名交付') {
    publish(engine, 'private-monthly', monthlyName, monthlyText, 'other-room');
  } else {
    assert.equal(condition, '本群仅有尚未成功发布的月报');
    const task = engine.submit('r', { id: 'draft-monthly', text: '写月报', mentions: ['A'] }).taskId!;
    assert(engine.send('r', task, { id: 'artifact-draft', at: 1, type: 'ARTIFACT',
      artifact: { id: 'unpublished', name: monthlyName, content: monthlyText } }).ok);
    assert(engine.send('r', task, { id: 'stop-draft', at: 2, type: 'STOP' }).ok);
  }
});

When('用户从上一轮 {string} 提炼业务进展和专项成果', function (this: SpecWorld, reference: string) {
  const run = monthly.get(this)!;
  run.earlier = run.store.read('r');
  run.submitted = run.engine.submit('r', { id: 'extract-monthly', text: `从上一轮 ${reference} 提炼业务进展和专项成果，排版从简` });
});

Then('新任务应固定名为{string}的月报原文且模型只按本轮要求提炼', function (this: SpecWorld, name: string) {
  const { engine, original, submitted } = monthly.get(this)!;
  assert(submitted?.ok && submitted.taskId);
  const c = engine.view('r', submitted.taskId)!.context;
  assert.partialDeepStrictEqual(c.sourceArtifact, { ...original, purpose: 'extract', name, content: monthlyText,
    contentHash: createHash('sha256').update(monthlyText).digest('hex') });
  assert.equal(c.goal.requiredArtifacts, 0);
  assert.deepEqual(engine.pending('r', submitted.taskId).map(work => work.kind), ['interpretation']);
});

When('负责人提交两项提炼正文', async function (this: SpecWorld) {
  const { engine, original, submitted } = monthly.get(this)!;
  const task = submitted!.taskId!;
  const config = engine.config;
  let calls = 0;
  const adapter = new OpenAICompatibleAdapter(config, { env: {}, clock: () => 10, transport: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const context = JSON.parse(request.messages[1].content).context;
    assert.partialDeepStrictEqual(context.sourceArtifact, { ...original, purpose: 'extract', content: monthlyText });
    if (++calls === 1) return modelResponse({ type: 'interpretation', spec: { action: 'request', objective: '提炼业务进展和专项成果',
      constraints: ['排版从简'], expectedOutputs: ['两项提炼正文'], acceptanceCriteria: [], references: [], confidence: 1, clarification: null } });
    assert.equal(calls, 2);
    assert.match(request.messages[0].content, /extract only the requested scope/i);
    assert.doesNotMatch(request.messages[0].content, /a-revised\.md/);
    return modelResponse({ type: 'deliver', text: extractText, artifactIds: [] });
  } });
  const runner = new WorkRunner(engine, adapter, () => 10);
  assert(await runner.runOne('r', task));
  assert(await runner.runOne('r', task));
  assert.equal(calls, 2);
  passFixtureCheck(engine, 'r', task, 'check-extraction', 11);
});

Then('群聊应交付新正文且旧月报只作为输入来源', function (this: SpecWorld) {
  const { engine, submitted, original, earlier, store } = monthly.get(this)!;
  const c = engine.view('r', submitted!.taskId)!.context;
  assert.equal(c.outcome, 'complete');
  assert.equal(c.messages.at(-1)!.detailText ?? c.messages.at(-1)!.text, extractText);
  assert.deepEqual(c.publishedDelivery?.artifactIds, []);
  assert.deepEqual(c.artifacts, []);
  assert.deepEqual(store.read('r').tasks[original!.sourceTaskId], earlier!.tasks[original!.sourceTaskId]);
});

Then('应给出{string}且不创建任务或泄露原文', function (this: SpecWorld, code: string) {
  const { store, earlier, submitted } = monthly.get(this)!;
  assert.equal(submitted?.code, code);
  assert.equal(submitted?.ok, false);
  assert.deepEqual(store.read('r'), earlier);
  assert(!JSON.stringify(submitted).includes(monthlyText));
  if (code === 'AMBIGUOUS_SOURCE_ARTIFACT') {
    assert.deepEqual(submitted.sourceCandidates?.map(item => item.name), [monthlyName, monthlyName]);
    assert(submitted.sourceCandidates?.every(item => !Object.hasOwn(item, 'content')));
  } else assert.equal(submitted.sourceCandidates, undefined);
});
