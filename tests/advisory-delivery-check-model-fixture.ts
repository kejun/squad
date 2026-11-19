import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { type CheckDiagnostic } from '../src/delivery-acceptance.js';
import { publicationIds } from '../src/task/delivery.js';
import { fixedCandidate } from './delivery-cycle-fixture.js';
import { claimCheck, passCheck } from './host-retry-model-fixture.js';

function protocolFailure(run: ReturnType<typeof fixedCandidate>, diagnostic: CheckDiagnostic) {
  const { m, check } = run;
  assert(m.send({ type: 'WORK_FAILED', intentId: check.id, attempt: check.attempt, fence: check, transient: true,
    reason: diagnostic.code, checkDiagnostic: diagnostic }).ok);
}

export function advisoryCheckModelGate() {
  const run = fixedCandidate();
  const { m, revision } = run;
  const original = structuredClone(m.c.candidate!);
  protocolFailure(run, { code: 'CHECK_INVALID_RESULT' });
  run.check = claimCheck(m);
  const missed = original.acceptance!.criteria[0]!;
  protocolFailure(run, { code: 'CHECK_MISSING_CRITERION', criterionId: missed.id });
  assert.equal(m.snapshot.value, 'ended');
  assert.equal(m.c.outcome, 'complete');
  assert.equal(m.c.publishedDelivery?.revision, revision);
  assert.equal(m.c.candidate?.text, original.text);
  assert(m.c.messages.some(item => item.kind === 'notice' && item.text.includes('是否重试')));
  assert.equal(m.c.usage.checks, 2);

  const retry = { type: 'CONTINUE', retryCheck: true, text: '重试检查' } as const;
  const published = publicationIds(m.c);
  assert(m.send(retry).ok);
  assert.equal(m.snapshot.value, 'checking');
  assert.deepEqual(publicationIds(m.c), published);
  const current = claimCheck(m);
  assert.notEqual(current.id, run.check.id);
  assert.deepEqual(current.payload.candidate, original);
  assert(!m.send({ type: 'CHECK_RESULT', workId: run.check.id, attempt: run.check.attempt, fence: run.check,
    resultId: 'late-check', candidateRevision: revision, criteriaResults: [] }).ok);
  assert(passCheck(m, current, 'advisory-recheck-passed').ok);
  assert.equal(m.c.outcome, 'complete');
  assert.equal(m.c.publishedDelivery?.revision, revision);
  assert.equal(m.c.candidate?.deliveryIssue, undefined);
  assert.equal(m.c.usage.checks, 3);
  assert.equal(m.c.messages.filter(item => item.kind === 'final').length, 1);

  const finding = fixedCandidate();
  const { m: withFinding, check } = finding;
  assert(withFinding.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt,
    resultId: 'negative', candidateRevision: finding.revision,
    criteriaResults: withFinding.c.candidate!.acceptance!.criteria.map((item, index) => index === 0
      ? { criterionId: item.id, status: 'failed', reason: '缺少实际退出码' } : { criterionId: item.id, status: 'passed' }) }).ok);
  assert.equal(withFinding.c.outcome, 'complete');
  assert(withFinding.c.messages.some(item => item.kind === 'notice' && item.text.includes('缺少实际退出码') && item.text.includes('是否重试')));
  return { technicalAttempts: 2, explicitRetry: 1, findings: 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(advisoryCheckModelGate()));
