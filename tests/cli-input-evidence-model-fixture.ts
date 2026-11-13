import { deliveryValidationOperation } from '../src/task/verification.js';
import assert from 'node:assert/strict';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';
import { deliveryEvidence } from '../src/task/evidence.js';
import { repeatedCliFailures } from '../src/cli-failure.js';
import type { LocalAction } from '../src/local-operation.js';
import { candidateJudgments } from './helpers.js';
import { LocalModel } from './local-model-fixture.js';

const action: Extract<LocalAction, { type: 'runCli' }> = { type: 'runCli', executable: 'tesseract', args: ['stdin', 'stdout'], stdin: { path: '.tmp/input.pgm' }, execution: 'sandbox' };
export const measuredInvocation = { executable: '/usr/bin/tesseract', args: ['stdin', 'stdout'], cwd: '/task', execution: 'sandbox',
  environmentHash: 'e'.repeat(64), stdin: { path: '.tmp/input.pgm', sha256: 'a'.repeat(64), bytes: 456 } };
const receipt = { ok: true, code: 'succeeded', data: { stdout: 'HELLO\n', stderr: '', exitCode: 0, truncated: false,
  invocation: measuredInvocation, validationInputsChanged: null,
  capturedEvidence: { stdout: { capturedContentHash: 'd'.repeat(64), bytes: 6, chars: 6 } } } };

export function inputEvidenceModel() {
  const m = new LocalModel(); assert(m.request(action).ok); assert(m.claim().ok); assert(m.started().ok); assert(m.result({ result: receipt }).ok);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: 'HELLO；候选自报输入哈希 forged-owner-hash', artifactIds: [] }).ok);
  const check = m.c.intents.find(work => work.kind === 'check')!;
  assert(m.send({ type: 'CLAIM', intentId: check.id }).ok);
  return { m, check: m.c.intents.find(work => work.id === check.id)! };
}
export function assertTrustedInputProjection() {
  const { m, check } = inputEvidenceModel();
  const material = deliveryCheckMaterials(m.c, check)!;
  assert.deepEqual(material.evidence[0]!.metadata.command.invocation, measuredInvocation);
  assert.equal(material.evidence[0]!.metadata.validationInputsChanged, null);
  assert(!JSON.stringify(material.evidence).includes('forged-owner-hash'));
  assert.equal(material.evidence[0]!.stdout, 'HELLO\n');
}
export function assertFrozenInputRefRejects(change: string) {
  const fixture = inputEvidenceModel(); mutateInputEvidence(fixture, change); assertChangedInputEvidenceRejected(fixture);
}
export function mutateInputEvidence({ m }: ReturnType<typeof inputEvidenceModel>, change: string) {
  const source = m.c.intents.find(work => work.id === m.work.id)!.localOperations![0]!;
  const data = source.result!.data;
  const invocation = data.invocation as typeof measuredInvocation;
  if (change === '执行参数') invocation.args = ['another'];
  else if (change === '执行环境') invocation.execution = 'host';
  else if (change === '输入路径') invocation.stdin.path = '.tmp/another.pgm';
  else if (change === '输入大小') invocation.stdin.bytes++;
  else if (change === '输入哈希') invocation.stdin.sha256 = 'b'.repeat(64);
  else if (change === '调用元数据') delete data.invocation;
  else if (change === '输入指纹') delete (invocation as { stdin?: unknown }).stdin;
  else if (change === '校验事实') data.validationInputsChanged = true;
  else if (change === '原始操作') source.action = { ...action, args: ['mutated-action'] };
  else if (change === '旧引用缺少调用快照') delete m.c.deliveryCycle!.evidence![0]!.cliSnapshot;
  else throw new Error(`Unknown input evidence change: ${change}`);
}
export function assertChangedInputEvidenceRejected({ m, check }: ReturnType<typeof inputEvidenceModel>) {
  assert.equal(deliveryEvidence(m.c, check, m.c.deliveryCycle!.evidence), undefined);
  assert.equal(deliveryCheckMaterials(m.c, check), undefined);
  assert(m.send({ type: 'CONSUME', intentId: check.id, attempt: check.attempt, fence: check }).ok);
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, resultId: 'input-evidence-check', fence: check, attempt: check.attempt,
    candidateRevision: m.c.candidate!.revision, criteriaResults: candidateJudgments(m.c.candidate) }).ok);
  assert.equal(m.c.reason, '检查未完成（CHECK_EVIDENCE_CHANGED）');
}
export function assertUnknownInputDoesNotBlockPureRequest() {
  const m = new LocalModel();
  const failure = { ...receipt, ok: false, code: 'failed', data: { ...receipt.data, exitCode: 2, stderr: 'unknown option in supplied input' } };
  assert(m.request(action).ok); assert(m.claim().ok); assert(m.started().ok); assert(m.result({ result: failure }).ok);
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op2', namespace: 'c'.repeat(64), requestHash: 'b'.repeat(64), action,
    parentAttempt: m.work.attempt, messages: [], workspaceId: 'project', fence: m.work }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: m.work.id, operationId: 'op2', sessionId: 'session2', parentAttempt: m.work.attempt, leaseAvailable: true, fence: m.work }).ok);
  assert(m.send({ type: 'LOCAL_STARTED', intentId: m.work.id, operationId: 'op2', sessionId: 'session2' }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: m.work.id, operationId: 'op2', sessionId: 'session2', result: failure, settled: true, effectsKnown: true }).ok);
  const work = m.c.intents.find(work => work.id === m.work.id)!;
  assert.equal(repeatedCliFailures(work, action), 0, 'the pure request has not measured current input bytes');
  assert.equal(repeatedCliFailures(work, action, { ...measuredInvocation.stdin, environmentHash: measuredInvocation.environmentHash }), 2);
  assert.equal(repeatedCliFailures(work, action, { ...measuredInvocation.stdin, sha256: 'f'.repeat(64), environmentHash: measuredInvocation.environmentHash }), 0);
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'op3', namespace: 'c'.repeat(64), requestHash: 'f'.repeat(64), action,
    parentAttempt: work.attempt, messages: [], workspaceId: 'project', fence: work }).ok);
}
export function assertFixedCheckRejectsAddedStdin() {
  const m = new LocalModel(input => { input.goal.text = '运行 npm test'; input.message.text = '运行 npm test'; });
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '待核查', artifactIds: [] }).ok);
  const check = m.c.intents.find(work => work.kind === 'check')!;
  assert(m.send({ type: 'CLAIM', intentId: check.id }).ok);
  m.work = m.c.intents.find(work => work.id === check.id)!;
  assert(m.request({ type: 'runCli', executable: 'npm', args: ['test'], execution: 'sandbox', stdin: { path: '.tmp/unapproved-input' } }).ok);
  assert.equal(deliveryValidationOperation(m.c.intents.find(w=>w.id===check.id)!),undefined,'A remedial command with extra stdin is not the required validation command');
}
