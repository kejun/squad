import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import { claimCheck } from './host-retry-model-fixture.js';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';

export const originalEvidence = `${'无关的已保存来源正文。\n'.repeat(3000)}\n付款已经完成。\n来源结束`;
export const originalReport = `${'保留的报告正文。\n'.repeat(1800)}\n测试通过，来源：https://example.test/source。\n付款尚未完成。`;
export const revisedReport = originalReport.replace('付款尚未完成。', '付款已经完成。');
export const removedRequirement = '测试通过，来源：https://example.test/source。';
export const regressedReport = revisedReport.replace(removedRequirement + '\n', '');

export function prepareDeltaModel() {
  const m = new LocalModel();
  assert(m.request().ok); assert(m.claim().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout: originalEvidence, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: 'a'.repeat(64), bytes: Buffer.byteLength(originalEvidence), chars: [...originalEvidence].length } } } } }).ok);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, attempt: m.work.attempt,
    text: '报告', artifactIds: [], artifacts: [{ name: 'report.md', content: originalReport }] }).ok);
  const first = claimCheck(m);
  assert.equal(deliveryCheckMaterials(m.c, first)?.delta, undefined);
  const results = m.c.candidate!.acceptance!.criteria.map((criterion, index) => index === 0
    ? { criterionId: criterion.id, status: 'failed', reason: '付款状态有误', source: { id: 'op1', quote: '付款已经完成。' } }
    : { criterionId: criterion.id, status: 'passed' });
  assert(m.send({ type: 'CHECK_RESULT', workId: first.id, fence: first, attempt: first.attempt,
    resultId: 'first-result', candidateRevision: m.c.candidate!.revision, criteriaResults: results }).ok);
  return { m, first: m.c.intents.find(item => item.id === first.id)!, original: m.c.artifacts[0]! };
}
export function submitRevision(run: ReturnType<typeof prepareDeltaModel>, content = revisedReport) {
  const { m, original } = run;
  const pending = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = m.c.intents.find(item => item.id === pending.id)!;
  assert(m.send({ type: 'DELIVER', workId: work.id, fence: work, attempt: work.attempt,
    text: '报告', artifactIds: [], artifacts: [{ name: 'report.md', content, replacesArtifactId: original.id }] }).ok);
  return m.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
}
export function changedHash(run: ReturnType<typeof prepareDeltaModel>) {
  const op = run.m.c.intents.flatMap(item => item.localOperations ?? []).find(item => item.id === 'op1')!;
  (op.result!.data.capturedEvidence as { stdout: { capturedContentHash: string } }).stdout.capturedContentHash = 'b'.repeat(64);
}
export function deltaGate() {
  const run = prepareDeltaModel(), second = submitRevision(run);
  assert.equal(second.payload.baselineCheckId, run.first.id);
  const material = deliveryCheckMaterials(run.m.c, second)!;
  assert.equal(material.delta?.baseWorkId, run.first.id);
  assert.equal(material.delta?.previousResults.length, 2);
  assert.equal(material.requirements.length, 2);
  assert.equal(material.delta?.artifacts[0]?.change.removed, '尚未');
  assert.equal(material.delta?.artifacts[0]?.change.added, '已经');
  assert(material.evidence[0]?.stdout?.includes('付款已经完成。'));
  assert(JSON.stringify(material).length < originalEvidence.length / 2);
  assert.equal(material.artifacts.length, 0);
  assert.equal(material.delta?.sources[0]?.id, 'op1');
  assert.equal(JSON.stringify(deliveryCheckMaterials(run.m.c, second)), JSON.stringify(material));
  const regression = prepareDeltaModel(), regressed = submitRevision(regression, regressedReport);
  assert(deliveryCheckMaterials(regression.m.c, regressed)?.delta?.artifacts[0]?.change.removed.includes(removedRequirement));
  const regressionCheck = claimCheck(regression.m);
  assert(regression.m.send({ type: 'CHECK_RESULT', workId: regressionCheck.id, fence: regressionCheck, attempt: regressionCheck.attempt,
    resultId: 'regression-failed', candidateRevision: regression.m.c.candidate!.revision,
    criteriaResults: regression.m.c.candidate!.acceptance!.criteria.map((item, index) => index === 1
      ? { criterionId: item.id, status: 'failed', reason: '修订删除了原来通过的验收内容' } : { criterionId: item.id, status: 'passed' }) }).ok);
  assert.equal(regression.m.c.publishedDelivery, undefined);
  assert.notEqual(regression.m.c.outcome, 'complete');
  assert.equal(regression.m.c.intents.find(item => item.id === regressionCheck.id)?.criteriaResults?.[1]?.status, 'failed');
  const fresh = prepareDeltaModel();
  const newFacts = submitRevision(fresh, revisedReport + '\n另外已经完成发货。');
  assert.equal(deliveryCheckMaterials(fresh.m.c, newFacts)?.delta, undefined);
  assert.equal(deliveryCheckMaterials(fresh.m.c, newFacts)?.artifacts.find(item => !item.background)?.content, revisedReport + '\n另外已经完成发货。');
  for (const boundary of ['缺少检查结果', '属于其他轮次', '来源无法定位', '原始要求变化']) {
    const isolated = prepareDeltaModel();
    changeBaseline(isolated, boundary);
    assert.equal(deliveryCheckMaterials(isolated.m.c, submitRevision(isolated))?.delta, undefined, boundary);
  }
  const stale = prepareDeltaModel(), staleCheck = submitRevision(stale); changedHash(stale);
  assert.equal(deliveryCheckMaterials(stale.m.c, staleCheck), undefined);
  const incomplete = prepareDeltaModel(); submitRevision(incomplete); const check = claimCheck(incomplete.m);
  assert(incomplete.m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt,
    resultId: 'missing-judgment', candidateRevision: incomplete.m.c.candidate!.revision,
    criteriaResults: [{ criterionId: incomplete.m.c.candidate!.acceptance!.criteria[0]!.id, status: 'passed' }] }).ok);
  assert.equal(incomplete.m.c.outcome, null);
  assert.equal(incomplete.m.c.publishedDelivery, undefined);
  assert.equal(incomplete.m.c.intents.find(item => item.id === check.id)?.status, 'pending');
  const retry = prepareDeltaModel(); const retryPending = submitRevision(retry), requested = claimCheck(retry.m);
  const before = deliveryCheckMaterials(retry.m.c, requested)!;
  assert(retry.m.send({ type: 'WORK_FAILED', intentId: requested.id, fence: requested, attempt: requested.attempt,
    transient: true, reason: 'NETWORK_ERROR' }).ok);
  const retried = claimCheck(retry.m);
  assert.equal(retried.id, retryPending.id);
  assert.deepEqual(deliveryCheckMaterials(retry.m.c, retried), before);
  assert(retry.m.send({ type: 'CHECK_RESULT', workId: retried.id, fence: retried, attempt: retried.attempt,
    resultId: 'retry-passed', candidateRevision: retry.m.c.candidate!.revision,
    criteriaResults: retry.m.c.candidate!.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) }).ok);
  assert.equal(retry.m.c.outcome, 'complete');
}
export function changeBaseline(run: ReturnType<typeof prepareDeltaModel>, boundary: string) {
  if (boundary === '缺少检查结果') delete run.first.criteriaResults;
  if (boundary === '属于其他轮次') run.first.epoch--;
  if (boundary === '来源无法定位') delete run.first.criteriaResults![0]!.source;
  if (boundary === '原始要求变化') (run.first.payload.candidate as { acceptance: { criteria: { text: string }[] } }).acceptance.criteria[0]!.text = '旧要求';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deltaGate(); process.stdout.write('BT_F65–F70/BT_F83 real XState delta gate passed with snapshot round trips.\n');
}
