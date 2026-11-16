import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { CheckMaterials } from '../../src/delivery-acceptance.js';
import type { LocalToolResult } from '../../src/local-operation.js';
import { LocalFixture } from '../local-tools-fixture.js';
import {
  acquireEvidence, attemptUnassignedEvidence, checkEvidence, checkReadBoundary, evidenceIndexInModel, fixtureBody, readFromExecution,
  readHistoricalEvidence, readTruncatedEvidence, refreshEvidence, restartEvidenceRead, reviseEvidenceCandidate, seedMissingEvidence,
} from '../task-evidence-fixture.js';
import type { SpecWorld } from './steps.js';

interface State {
  fixture?: LocalFixture;
  source?: string;
  sourceMode?: string;
  outcome?: LocalToolResult;
  pages?: LocalToolResult[];
  boundaryResult?: string;
  checks?: CheckMaterials[];
}
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => {
  let current = states.get(world);
  if (!current) { current = {}; states.set(world, current); }
  return current;
};
const quote = (step: string) => new RegExp(`^${step.replace('「…」', '「(.+)」')}$`);
async function prepare(world: SpecWorld) {
  const s = state(world);
  s.fixture = await LocalFixture.create('方案师', true);
  s.source = (await acquireEvidence(s.fixture)).id;
  return s;
}
After(async function (this: SpecWorld) { await states.get(this)?.fixture?.close(); });

Given('负责人已经取得资料并保存完整的执行回执', async function (this: SpecWorld) { await prepare(this); });
Given('当前目标已经保存一次资料采集的执行证据', async function (this: SpecWorld) { await prepare(this); });
Given('当前目标保持不变且旧执行轮次保存了完整回执', async function (this: SpecWorld) { await prepare(this); });
When('系统为首检及用户明确续办后的检查准备固定材料', async function (this: SpecWorld) {
  const s = state(this);
  const first = await checkEvidence(s.fixture!, { status: 'failed', reason: '候选误述证据出处', source: { id: s.source!, quote: '真实正文' } });
  await reviseEvidenceCandidate(s.fixture!);
  s.checks = [first, await checkEvidence(s.fixture!)];
});
Then('检查员应从同一证据快照各一次取得原正文、来源和采集时间', function (this: SpecWorld) {
  const s = state(this);
  const [first, review] = s.checks!;
  const [source] = first!.evidence;
  assert.equal(first!.evidence.length, 1);
  assert.deepEqual(review!.evidence, first!.evidence.map(item => ({ ...item, metadata: { ...item.metadata, historicalObservation: true } })));
  assert.notEqual(review!.candidate.revision, first!.candidate.revision);
  assert.equal(review!.previousResults[0]?.source?.id, s.source);
  assert.equal(source?.stdout, fixtureBody);
  assert.equal(source?.id, s.source);
  assert.equal(source?.metadata.capturedContentHash, '8c9e8bdc687603a2133daa7b80433dde7e4f42c35b7fd7ad76a4f3de1141efbd');
  assert.equal(source?.metadata.obtainedAt, 0);
  assert.equal(source?.metadata.stdoutBytes, 27);
  assert.equal(source?.metadata.stdoutChars, 16);
  assert.equal(source?.metadata.completeness, 'complete');
});
Then('检查不应分页查读、再次执行命令或申请宿主批准', function (this: SpecWorld) {
  const f = state(this).fixture!;
  assert.equal(f.backend.calls.length, 1);
  assert.equal(f.h.context().usage.checks, 2);
  assert.equal(f.h.context().outcome, 'complete');
  assert(f.h.context().intents.every(work => !work.localOperations?.some(op => op.approval || op.action.type === 'readEvidence')));
});
When('用户明确要求重新获取该资料', async function (this: SpecWorld) {
  await refreshEvidence(state(this).fixture!);
});
Then('新操作应实际采集资料并保存独立回执', function (this: SpecWorld) {
  const f = state(this).fixture!;
  assert.equal(f.backend.calls.length, 2);
  const receipts = f.h.context().intents.flatMap(work => work.localOperations ?? []).filter(op => op.action.type === 'runCli');
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0]?.id, receipts[1]?.id);
  assert.equal(receipts[0]?.requestHash, receipts[1]?.requestHash);
  assert(receipts.every(op => op.status === 'succeeded'));
});
Then('新旧证据应分别标识原执行和采集时间', async function (this: SpecWorld) {
  const s = state(this);
  const entries = (await checkEvidence(s.fixture!)).evidence.map(source => source.metadata);
  assert.deepEqual(entries.map(entry => entry.obtainedAt), [0, 50]);
  assert.equal(entries[0]?.sourceOperationId, s.source);
  assert.notEqual(entries[1]?.sourceOperationId, s.source);
});
Given(quote('资料的原执行证据为「…」'), async function (this: SpecWorld, mode: string) {
  const s = state(this);
  s.fixture = await LocalFixture.create('方案师', true);
  s.sourceMode = mode;
  if (mode === '正文缺失') { s.source = seedMissingEvidence(s.fixture); return; }
  const script = mode === '正文截断' ? "process.stdout.write('🍀'.repeat(20000))" : 'process.exitCode = 7';
  s.source = (await acquireEvidence(s.fixture, { type: 'runCli', executable: 'node', args: ['-e', script] })).id;
});
When('负责人在执行阶段查读对应证据', async function (this: SpecWorld) {
  const s = state(this);
  if (s.sourceMode === '正文截断') s.pages = await readTruncatedEvidence(s.fixture!, s.source!);
  else s.outcome = await readFromExecution(s.fixture!, s.source!);
});
Then(quote('应返回「…」'), function (this: SpecWorld, range: string) {
  const s = state(this);
  if (range === '已保存的部分正文及保存边界') {
    const pages = s.pages!;
    assert(pages.length > 1);
    assert(pages.every(page => page.code === 'EVIDENCE_PAGE'
      && (page.data.evidence as { completeness: string }).completeness === 'truncated'));
    assert.equal(pages.at(-1)?.data.atSavedBoundary, true);
    assert.equal(pages.at(-1)?.data.nextCursor, null);
    assert.equal(pages.map(page => page.data.text).join(''), '🍀'.repeat(8000));
  } else if (range === '确定失败及其来源') {
    assert.equal(s.outcome?.code, 'EVIDENCE_SOURCE_FAILED');
    assert.equal((s.outcome?.data.evidence as { sourceOperationId: string }).sourceOperationId, s.source);
    assert(!('text' in s.outcome!.data));
  } else {
    assert.equal(s.outcome?.code, 'EVIDENCE_CONTENT_MISSING');
    assert(!('text' in s.outcome!.data));
  }
});
Then('查读不应再次执行原命令', function (this: SpecWorld) {
  const s = state(this);
  assert.equal(s.fixture!.backend.calls.length, s.sourceMode === '正文缺失' ? 0 : 1);
});
Given(quote('成员尝试查读「…」'), async function (this: SpecWorld, reference: string) {
  const s = state(this);
  s.fixture = await LocalFixture.create('方案师', true);
  s.sourceMode = reference;
  if (reference === '未分配给协作者的证据') return;
  const ownSource = await acquireEvidence(s.fixture);
  if (reference === '旧目标证据') {
    s.source = ownSource.id;
    assert(s.fixture.h.event({ type: 'USER_INPUT', text: '切换目标', goal: { ...s.fixture.h.context().goal, text: '独立新目标' } }).ok);
    await acquireEvidence(s.fixture);
    return;
  }
  const room = 'other-room';
  s.fixture.h.engine.submit(room, { id: 'different-task', text: '独立资料', goal: s.fixture.h.context().goal });
  s.source = seedMissingEvidence(s.fixture, room, 'task:different-task');
});
When('系统处理查读请求', async function (this: SpecWorld) {
  const s = state(this);
  s.outcome = s.sourceMode === '未分配给协作者的证据'
    ? await attemptUnassignedEvidence(s.fixture!) : await readFromExecution(s.fixture!, s.source!);
});
Then('应拒绝未获准的证据读取', function (this: SpecWorld) {
  assert.equal(state(this).outcome?.code, 'EVIDENCE_UNAVAILABLE');
});
Then('不应暴露该证据正文', function (this: SpecWorld) {
  const s = state(this);
  assert.deepEqual(s.outcome?.data, {});
  assert(!JSON.stringify(evidenceIndexInModel(s.fixture!)).includes(s.source ?? fixtureBody));
});
Given('当前任务保存了可查读的证据', function (this: SpecWorld) { state(this); });
When(quote('查读遇到「…」'), async function (this: SpecWorld, boundary: string) {
  const s = state(this);
  if (boundary === '已保存分页回执后重启') {
    await restartEvidenceRead('succeeded');
    s.boundaryResult = '返回原回执且不重复扣额';
  } else if (boundary === '领取后未保存分页回执时重启') {
    await restartEvidenceRead('claimed');
    s.boundaryResult = '复用同一读取意图且不重复扣额';
  } else {
    s.fixture = await LocalFixture.create('方案师', true, false, boundary === '没有读取额度' ? { ordinaryLimit: 4 } : {});
    await checkReadBoundary(s.fixture, boundary);
    s.boundaryResult = boundary === '领取前停止' ? '尚未读取且额度未消费' : '尚未读取且明确额度不足';
  }
});
Then(quote('应保留「…」'), function (this: SpecWorld, expected: string) {
  assert.equal(state(this).boundaryResult, expected);
});
When('负责人在新执行轮次查读该证据', async function (this: SpecWorld) {
  const s = state(this);
  s.outcome = await readHistoricalEvidence(s.fixture!, s.source!);
});
Then('应取得带原执行轮次和采集时间的历史观测', function (this: SpecWorld) {
  const s = state(this);
  const [meta] = evidenceIndexInModel(s.fixture!);
  assert.equal(meta?.sourceOperationId, s.source);
  assert.equal(meta?.historicalObservation, true);
  assert.equal(meta?.epoch, s.fixture!.h.context().epoch - 1);
  assert.equal(meta?.obtainedAt, 0);
  assert.equal(s.outcome?.data.text, fixtureBody);
});
Then('历史观测不应替代当前工程版本检查或最新资料验证', function (this: SpecWorld) {
  const f = state(this).fixture!;
  assert.equal(evidenceIndexInModel(f)[0]?.resourceVersion, null);
  assert(f.requests.at(-1)?.messages[0]?.content.includes('cannot confirm a current workspace revision or remote freshness'));
  assert.equal(f.backend.calls.length, 1);
});
