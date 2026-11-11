import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { LocalModel } from './local-model-fixture.js';
import { observeResourceAcquisition, operationAcquisitionSnapshot } from '../src/resource-acquisition.js';

const currentDocument = { data: { id: 'doc-4', slug: 'four', body: '进行中，等待评审。' } };
const documents = { data: [{ id: 'doc-4', slug: 'four', body: '待开始，尚未安排执行。' }, { id: 'doc-5', body: '进行中，等待评审。' }] };
export function sourceClaimsModel(source = '同文档') {
  const m = new LocalModel();
  const stdout = source === '非JSON正文' ? '进行中' : JSON.stringify(source === '文档标识重复'
    ? { data: [{ id: 'doc-5', body: '进行中' }, { id: 'doc-5', body: '待开始' }] } : source === '同文档' ? currentDocument : documents);
  assert(m.request().ok); assert(m.claim().ok); assert(m.started().ok);
  assert(m.result({ result: { ok: source !== '失败回执', code: source === '失败回执' ? 'failed' : 'succeeded',
    data: { stdout, exitCode: source === '失败回执' ? 1 : 0, truncated: source === '截断正文',
      capturedEvidence: { stdout: { capturedContentHash: createHash('sha256').update(stdout).digest('hex'),
        bytes: Buffer.byteLength(stdout), chars: Array.from(stdout).length } } } } }).ok);
  if (!['失败回执', '截断正文', '非JSON正文', '文档标识重复'].includes(source)) {
    const parsed = JSON.parse(stdout).data as { id: string; body: string } | { id: string; body: string }[];
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    for (const doc of docs) {
      const op = m.op!, resource = { kind: 'document' as const, service: 'fixture-documents', namespace: 'source-claims', id: doc.id };
      const receipt = observeResourceAcquisition({ id: `${op.id}:${doc.id}`, operationId: op.id, taskId: m.c.taskId,
        workId: m.work.id, attempt: m.work.attempt, epoch: m.work.epoch, goalVersion: m.work.goalVersion,
        source: 'runCli', requestHash: op.requestHash, requestedResource: resource, resource, content: doc.body,
        contentHash: createHash('sha256').update(doc.body).digest('hex'), complete: true,
        verifier: { id: 'source-claims-host-fixture', version: '1' }, executionSucceeded: true,
        sourceSnapshot: operationAcquisitionSnapshot(op), at: m.at });
      assert(m.send({ type: 'RECORD_ACQUISITION', intentId: m.work.id, receipt, fence: m.work, attempt: m.work.attempt }).ok);
    }
  }
  if (source === '旧目标') {
    m.c.intents.push({ ...structuredClone(m.c.intents[0]!), id: 'old-source', goalVersion: 0, status: 'done' });
    m.c.intents[0]!.localOperations = [];
  }
  return { m, source, sourceDocId: ['跨文档', '只有别篇含状态'].includes(source) ? 'doc-4'
    : source === '文档不存在' ? 'missing-doc' : source === '同文档' ? 'doc-4' : 'doc-5', sourceEvidenceId: source === '未知回执' ? 'unknown' : 'op1' };
}
export function submitSourceClaim(run: ReturnType<typeof sourceClaimsModel>) {
  const { m, sourceDocId, sourceEvidenceId } = run;
  return m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, attempt: m.work.attempt,
    text: '文档工作清单', artifactIds: [], artifacts: [{ name: 'work-items.md', content: '当前工作项',
      sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId, sourceEvidenceId }] }] });
}
export function assertSourceGate(run: ReturnType<typeof sourceClaimsModel>, code?: string) {
  const { m } = run;
  if (code) {
    assert.equal(m.c.candidate?.deliveryIssue?.code, code);
    assert.equal(m.c.intents.filter(item => item.kind === 'check' && ['pending', 'inflight'].includes(item.status)).length, 0);
  } else {
    assert.equal(m.snapshot.value, 'checking');
    assert.equal(m.c.intents.filter(item => item.kind === 'check').length, 1);
  }
}
export function invalidSourceReport(problem: string) {
  const item: Record<string, unknown> = { text: '安排评审', status: '进行中', sourceDocId: 'doc-4', sourceEvidenceId: 'op1' };
  if (problem.startsWith('遗漏')) delete item[problem.slice(2)];
  const overrides: Record<string, Record<string, string>> = {
    '状态带换行': { status: '进行中\n待审核' }, '文档标识带换行': { sourceDocId: 'doc-4\n' },
    '回执标识带空字符': { sourceEvidenceId: 'op1\0' },
  };
  return { name: 'work.md', content: problem === '手写展示编号' ? 'D4 进行中' : '工作项',
    sourceItems: [{ ...item, ...overrides[problem] }] };
}

export function sourceReportRevision() {
  const run = sourceClaimsModel(); assert(submitSourceClaim(run).ok);
  const check = run.m.c.intents.find(work => work.kind === 'check')!;
  assert(run.m.send({ type: 'CLAIM', intentId: check.id }).ok);
  const claimed = run.m.c.intents.find(work => work.id === check.id)!;
  assert(run.m.send({ type: 'CONSUME', intentId: claimed.id, fence: claimed, attempt: claimed.attempt }).ok);
  assert(run.m.send({ type: 'CHECK_RESULT', workId: claimed.id, fence: claimed, attempt: claimed.attempt, resultId: 'needs-revision',
    candidateRevision: run.m.c.candidate!.revision, criteriaResults: run.m.c.candidate!.acceptance!.criteria.map(criterion =>
      ({ criterionId: criterion.id, status: 'failed', reason: '需要补充说明' })) }).ok);
  return run;
}
export function submitUnboundSuccessor(run: ReturnType<typeof sourceClaimsModel>) {
  const pending = run.m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(run.m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const owner = run.m.c.intents.find(work => work.id === pending.id)!;
  assert(run.m.send({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt,
    text: '修订后的工作项报告', artifactIds: [], artifacts: [{ name: 'work-items.md', content: '文档进行中',
      replacesArtifactId: run.m.c.artifacts[0]!.id }] }).ok);
}

export function verifySourceClaimsModel() {
  const valid = sourceClaimsModel(); assert(submitSourceClaim(valid).ok); assertSourceGate(valid);
  for (const [source, code] of [
    ['跨文档', 'SOURCE_STATUS_MISMATCH'], ['未知回执', 'SOURCE_EVIDENCE_UNAVAILABLE'],
    ['截断正文', 'SOURCE_EVIDENCE_UNAVAILABLE'], ['失败回执', 'SOURCE_EVIDENCE_UNAVAILABLE'],
    ['旧目标', 'SOURCE_EVIDENCE_UNAVAILABLE'], ['文档不存在', 'SOURCE_DOCUMENT_NOT_FOUND'],
    ['文档标识重复', 'SOURCE_DOCUMENT_AMBIGUOUS'], ['非JSON正文', 'SOURCE_DOCUMENT_NOT_FOUND'],
  ]) {
    const run = sourceClaimsModel(source); assert(submitSourceClaim(run).ok, source); assertSourceGate(run, code);
  }
  const legacy = sourceClaimsModel();
  assert(legacy.m.send({ type: 'DELIVER', workId: legacy.m.work.id, fence: legacy.m.work,
    text: '普通报告', artifactIds: [], artifacts: [{ name: 'ordinary.md', content: '普通正文' }] }).ok);
  assertSourceGate(legacy);
  const saved = JSON.parse(JSON.stringify(persistTask(valid.m.snapshot)));
  valid.m.snapshot = restoreTask(saved);
  assert.equal(valid.m.c.candidate?.revision, saved.context.candidate.revision);
  const successor = sourceReportRevision(); submitUnboundSuccessor(successor); assertSourceGate(successor, 'SOURCE_ITEMS_REQUIRED');
  return { paths: 11, model: 'taskMachine', baseline: 'KEJ-113 host acquisition receipts' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifySourceClaimsModel()));
