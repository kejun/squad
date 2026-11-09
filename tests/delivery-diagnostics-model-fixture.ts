import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import type { Intent } from '../src/types.js';
import type { CheckDiagnostic } from '../src/delivery-acceptance.js';

const source = '前言\n付款已经完成。\n资料结束';
const diagnostic: CheckDiagnostic = { code: 'CHECK_SOURCE_QUOTE_MISMATCH', criterionId: 'G1:goal:text', sourceId: 'M',
  quoteLength: 9, location: { field: 'content', offset: 3, matchedPrefixLength: 4 } };

function prepare() {
  const model = new LocalModel(input => { input.message.text = source; input.goal = { text: source, criteria: [], constraints: [], requiredArtifacts: 0 }; });
  assert(model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, attempt: model.work.attempt,
    text: '已生成报告', artifactIds: [], artifacts: [{ name: 'report.md', content: '付款已经完成。' }] }).ok);
  return model;
}
function request(model: LocalModel) {
  const pending = model.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
  assert(model.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = model.c.intents.find(item => item.id === pending.id)!;
  assert(model.send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok);
  return work;
}
function report(model: LocalModel, work: Intent, quote: string) {
  return model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt,
    resultId: `result:${work.attempt}`, candidateRevision: model.c.candidate!.revision,
    criteriaResults: [{ criterionId: 'G1:goal:text', status: 'passed', source: { id: 'M', quote } }] });
}

export function verifyDeliveryDiagnosticModel() {
  const model = prepare();
  assert(report(model, request(model), '付款已经全额完成。').ok);
  let check = model.c.intents.find(work => work.kind === 'check')!;
  assert.deepEqual(check.checkDiagnostics, [{ attempt: 1, candidateRevision: model.c.candidate!.revision, diagnostic }]);
  assert.equal(check.status, 'pending');
  assert.equal(model.c.usage.retries, 1);
  assert(report(model, request(model), '付款已经完成。').ok);
  assert.equal(model.c.outcome, 'complete');
  assert.equal(model.c.usage.checks, 2);

  const exhausted = prepare();
  const first = request(exhausted);
  assert(exhausted.send({ type: 'WORK_FAILED', intentId: first.id, fence: first, attempt: first.attempt,
    reason: diagnostic.code, transient: true, checkDiagnostic: diagnostic }).ok);
  const retry = request(exhausted);
  assert(exhausted.send({ type: 'WORK_FAILED', intentId: retry.id, fence: retry, attempt: retry.attempt,
    reason: diagnostic.code, transient: true, checkDiagnostic: diagnostic }).ok);
  check = exhausted.c.intents.find(work => work.kind === 'check')!;
  assert.equal(check.checkDiagnostics?.length, 2);
  assert.equal(exhausted.c.outcome, 'partial');
  assert.equal(exhausted.c.candidate?.deliveryIssue?.code, 'DELIVERY_CHECK_FAILED');
  assert.equal(exhausted.c.artifacts[0]?.content, '付款已经完成。');

  const stopped = prepare();
  const old = request(stopped);
  assert(stopped.send({ type: 'STOP' }).ok);
  stopped.send({ type: 'WORK_FAILED', intentId: old.id, fence: old, attempt: old.attempt,
    reason: diagnostic.code, transient: true, checkDiagnostic: diagnostic });
  assert.equal(stopped.c.intents.find(work => work.id === old.id)?.checkDiagnostics, undefined);
  assert.equal(stopped.c.deliveryCycle?.retry, undefined);
  assert.equal(stopped.c.publishedDelivery, undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDeliveryDiagnosticModel();
  process.stdout.write('BT_F60–F62 real XState diagnostic lifecycle passed (snapshot round trip after every event).\n');
}
