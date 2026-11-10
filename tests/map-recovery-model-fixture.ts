import assert from 'node:assert/strict';
import { persistTask, restoreTask } from '../src/task.machine.js';
import type { Intent, PartitionRecovery } from '../src/types.js';
import type { CriterionJudgment } from '../src/delivery-acceptance.js';
import { MapQueueModel } from './map-queue-fixture.js';

export function failedMap() {
  const m = new MapQueueModel();
  while (m.pending('assistance').length) {
    const work = m.start();
    const partition = work.payload.partition as { id: string };
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: work.id, fence: work, attempt: work.attempt,
      discussionId: work.discussionId!, status: partition.id === 'part-2' ? 'success' : 'failed',
      text: partition.id === 'part-2' ? '完整doc-2' : '未能取到正文' }).ok);
  }
  const summary = m.start(m.pending('discussionSummary')[0]!);
  assert(m.send({ type: 'DISCUSSION_RESULT', workId: summary.id, fence: summary, attempt: summary.attempt,
    discussionId: summary.discussionId!, status: 'partial', text: '八篇仅读到一篇' }).ok);
  const pending = m.pending('owner')[0]!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const owner = m.context.intents.find(work => work.id === pending.id)!;
  assert(m.send({ type: 'CONSUME', intentId: owner.id, fence: owner, attempt: owner.attempt }).ok);
  const sourceId = 'owner-fetch-all8';
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: owner.id, operationId: sourceId,
    namespace: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'yuque', args: ['show', 'doc', 'all-eight', '--json'] },
    parentAttempt: owner.attempt, fence: owner, messages: [], workspaceId: 'project' }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: owner.id, operationId: sourceId,
    parentAttempt: owner.attempt, fence: owner, sessionId: 'repair-cli', leaseAvailable: true }).ok);
  const docs = Array.from({ length: 8 }, (_, i) => ({ id: `doc-${i + 1}`, body: `完整doc-${i + 1}正文` }));
  const stdout = JSON.stringify(docs);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: owner.id, operationId: sourceId, sessionId: 'repair-cli',
    result: { ok: true, code: 'succeeded', data: { exitCode: 0, stdout, truncated: false,
      capturedEvidence: { stdout: { capturedContentHash: 'c'.repeat(64), bytes: Buffer.byteLength(stdout), chars: [...stdout].length } } } },
    settled: true, effectsKnown: true }).ok);
  const claims = m.queue.filter(part => part.status === 'failed').map(part => ({ discussionId: m.context.discussion!.id,
    partitionId: part.partitionId, sourceOperationIds: [sourceId] }));
  return { m, owner, sourceId, docs, claims, failures: structuredClone(m.context.discussion!.results.filter(item => item.status === 'failed')) };
}
export type RecoveryRun = ReturnType<typeof failedMap>;
export function submitRecovery(run: RecoveryRun, claims: PartitionRecovery[] | null = run.claims) {
  return run.m.send({ type: 'DELIVER', workId: run.owner.id, fence: run.owner, attempt: run.owner.attempt,
    text: '已补齐八篇并汇总', artifactIds: [], artifacts: [{ name: 'report.md', content: run.docs.map(doc => `${doc.id}: ${doc.body}`).join('\n') }],
    ...(claims === null ? {} : { partitionRecoveries: claims }) });
}
export function claimRecoveryCheck(run: RecoveryRun) {
  const pending = run.m.pending('check')[0]!; assert(pending);
  assert(run.m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const check = run.m.context.intents.find(work => work.id === pending.id)!;
  assert(run.m.send({ type: 'CONSUME', intentId: check.id, fence: check, attempt: check.attempt }).ok);
  return run.m.context.intents.find(work => work.id === pending.id)!;
}
export function recoveryPass(run: RecoveryRun): CriterionJudgment[] {
  return run.m.context.candidate!.acceptance!.criteria.map(criterion => {
    const number = /:part-(\d+)$/.exec(criterion.id)?.[1];
    return { criterionId: criterion.id, status: 'passed', ...(number ? { source: { id: run.sourceId, quote: `完整doc-${number}正文` } } : {}) };
  });
}
export function reportRecovery(run: RecoveryRun, check: Intent, results = recoveryPass(run), resultId = 'recovery-pass') {
  return run.m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt,
    candidateRevision: run.m.context.candidate!.revision!, resultId, criteriaResults: results });
}
export function assertNoRecovery(run: RecoveryRun) {
  assert.equal(run.m.context.publishedDelivery, undefined);
  assert.equal(run.m.queue.filter(part => part.resolution).length, 0);
  assert.deepEqual(run.m.context.discussion!.results.filter(item => item.status === 'failed'), run.failures);
}
export function fullRecovery(run = failedMap()) {
  assert(submitRecovery(run).ok); const check = claimRecoveryCheck(run);
  assert.equal(run.m.context.candidate!.acceptance!.criteria.filter(item => item.requiredSourceIds).length, 7);
  assert(reportRecovery(run, check).ok);
  assert.equal(run.m.context.outcome, 'complete');
  assert.equal(run.m.context.publishedDelivery?.revision, run.m.context.candidate!.revision);
  assert.equal(run.m.queue.filter(part => part.status === 'failed').length, 7);
  assert.equal(run.m.queue.filter(part => part.resolution?.candidateRevision === run.m.context.candidate!.revision).length, 7);
  assert.deepEqual(run.m.context.discussion!.results.filter(item => item.status === 'failed'), run.failures);
  return run;
}
export function partialRecovery(run = failedMap()) {
  assert(submitRecovery(run, run.claims.slice(0, 3)).ok); const check = claimRecoveryCheck(run);
  assert(reportRecovery(run, check).ok);
  assert.equal(run.m.context.outcome, 'partial');
  assert.equal(run.m.context.intents.find(work => work.id === check.id)?.criteriaResults?.length, run.m.context.candidate!.acceptance!.criteria.length);
  assertNoRecovery(run); return run;
}
export function absentRecovery(run = failedMap()) {
  assert(submitRecovery(run, null).ok); const check = claimRecoveryCheck(run);
  assert(reportRecovery(run, check).ok); assert.equal(run.m.context.outcome, 'partial'); assertNoRecovery(run); return run;
}
export function invalidRecovery(problem: string, run = failedMap()) {
  let claims = structuredClone(run.claims);
  const op = run.m.context.intents.find(work => work.id === run.owner.id)!.localOperations![0]!;
  if (problem === '未知分片') claims[0]!.partitionId = 'unknown';
  if (problem === '重复分片') claims = [claims[0]!, claims[0]!];
  if (problem === '错误讨论轮次') claims[0]!.discussionId = 'old-discussion';
  if (problem === '成功分片冒充待补齐') claims[0]!.partitionId = 'part-2';
  if (problem === '未知来源') claims[0]!.sourceOperationIds = ['unknown'];
  if (problem === '失败来源') { op.status = 'failed'; op.result!.ok = false; op.result!.data.exitCode = 1; }
  if (problem === '截断来源') op.result!.data.truncated = true;
  if (problem === '旧目标来源' || problem === '旧执行轮次来源') {
    const source = structuredClone(run.m.context.intents.find(work => work.id === run.owner.id)!);
    source.id = 'old-source'; source.status = 'done';
    source.localOperations![0]!.id = 'old-operation';
    if (problem === '旧目标来源') source.goalVersion--; else source.epoch--;
    run.m.context.intents.push(source); claims[0]!.sourceOperationIds = ['old-operation'];
  }
  if (problem === '非当前冻结来源') run.m.context.deliveryCycle!.evidence = [];
  assert(submitRecovery(run, claims).ok);
  assert.equal(run.m.pending('check').length, 0);
  assert(run.m.context.candidate?.deliveryIssue?.code.startsWith('MAP_RECOVERY_'));
  assertNoRecovery(run); return run;
}
export function preparedRecovery() { const run = failedMap(); assert(submitRecovery(run).ok); return run; }
export function invalidRecoveryJudgment(kind: 'missing' | 'wrong' | 'unauthorized', run = preparedRecovery()) {
  const check = claimRecoveryCheck(run), results = recoveryPass(run);
  const at = results.findIndex(item => item.source);
  if (kind === 'missing') delete results[at]!.source;
  else if (kind === 'unauthorized') results[at]!.source!.id = 'unknown-source';
  else results[at]!.source!.quote = '没有出现在原文中的引用';
  assert(reportRecovery(run, check, results).ok);
  assert.equal(run.m.context.deliveryCycle?.retry?.status, 'reserved');
  assertNoRecovery(run); return run;
}
export function failedRecoveryJudgment(status: 'failed' | 'unverified', run = preparedRecovery()) {
  const check = claimRecoveryCheck(run), results = recoveryPass(run);
  const at = results.findIndex(item => item.source);
  results[at] = { ...results[at]!, status, reason: '本片的指定来源不能证明目标文档已补齐' };
  assert(reportRecovery(run, check, results).ok);
  assert.equal(run.m.context.intents.find(work => work.id === check.id)!.criteriaResults![at]!.status, status);
  assertNoRecovery(run); return run;
}
export function stopRecovery(run = preparedRecovery()) {
  const check = claimRecoveryCheck(run); assert(run.m.send({ type: 'STOP' }).ok);
  assert.equal(reportRecovery(run, check).ok, false); assert(run.m.context.stopped); assertNoRecovery(run); return run;
}
export function restartRecovery(run = preparedRecovery()) {
  run.m.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(run.m.snapshot))));
  const check = claimRecoveryCheck(run); assert(reportRecovery(run, check).ok);
  const proofs = structuredClone(run.m.queue.map(part => part.resolution));
  assert.equal(reportRecovery(run, check).ok, false);
  assert.equal(run.m.context.outcome, 'complete'); assert.equal(run.m.context.usage.checks, 1);
  assert.deepEqual(run.m.queue.map(part => part.resolution), proofs); return run;
}
export function newInputRecovery(run = preparedRecovery()) {
  const check = claimRecoveryCheck(run); assert(run.m.send({ type: 'USER_INPUT', text: '补充：还需核对最新版本' }).ok);
  assert(reportRecovery(run, check).ok); assert.equal(run.m.context.outcome, null); assertNoRecovery(run); return run;
}
export function independentReviewRun() {
  const run = failedMap();
  run.m.context.review = { id: 'independent-review', request: '要求独立成员审查', targets: ['B'], completed: [],
    status: 'summarizing', epoch: run.m.context.epoch, goalVersion: run.m.context.goalVersion, incomplete: '独立审查尚未完成' };
  return run;
}
export function independentReviewRecovery(run = independentReviewRun()) {
  assert(submitRecovery(run).ok);
  const check = claimRecoveryCheck(run); assert(reportRecovery(run, check).ok);
  assert.equal(run.m.context.outcome, 'partial'); assertNoRecovery(run); return run;
}
export function formatRecovery() {
  const run = failedMap();
  assert(run.m.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: run.owner.id, fence: run.owner, attempt: run.owner.attempt, issue: 'invalid_work_output' }).ok);
  assert.equal(run.m.context.intents.find(work => work.id === run.owner.id)!.outputRepair?.count, 1);
  return fullRecovery(run);
}
export function mapRecoveryModelGate() {
  fullRecovery(); partialRecovery(); absentRecovery();
  for (const problem of ['未知分片','重复分片','错误讨论轮次','成功分片冒充待补齐','未知来源','失败来源','截断来源','旧目标来源','旧执行轮次来源','非当前冻结来源']) invalidRecovery(problem);
  invalidRecoveryJudgment('missing'); invalidRecoveryJudgment('wrong'); invalidRecoveryJudgment('unauthorized'); failedRecoveryJudgment('failed'); failedRecoveryJudgment('unverified');
  stopRecovery(); restartRecovery(); newInputRecovery(); independentReviewRecovery(); formatRecovery();
  console.log('KEJ-111 map recovery model: 23 paths passed, each event persisted/restored');
}
if (process.argv[1]?.endsWith('map-recovery-model-fixture.ts')) mapRecoveryModelGate();
