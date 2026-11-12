import assert from 'node:assert/strict';
import { ResilienceModel } from './task-resilience-model-fixture.js';
import { CapacityModel } from './map-capacity-model-fixture.js';
import { taskHumanGate } from '../src/task/resilience.js';
import { taskPhase } from '../src/task.machine.js';

/** Production XState, persisted after events; parallel error decisions are an ordering invariant. */
export function verifyModelServiceErrorModel() {
  const traces: string[] = [];
  for (const status of [400, 401, 403, 404, 422]) {
    const m = new ResilienceModel(); m.artifact(); const work = m.claim();
    assert(m.send({ type: 'WORK_FAILED', intentId: work.id, fence: work,
      code: `MODEL_HTTP_${status}`, reason: `Error: Model HTTP ${status} (A): permission_error`, transient: false }).ok);
    assert.equal(m.phase, 'waitingHuman');
    const gate = taskHumanGate(m.c)!;
    assert.equal(gate.cause, 'modelServiceError'); assert.equal(gate.code, `MODEL_HTTP_${status}`);
    assert.deepEqual(gate.decisions, ['skip', 'stop']);
    assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert.equal(taskHumanGate(m.c)?.id, gate.id);
    assert.equal(m.pending().length, 0);
    assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: status === 403 ? 'stop' : 'skip' }).ok);
    assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, status === 403 ? 'stopped' : 'partial');
    assert.equal(m.c.artifacts[0]!.content, '已保存但未核验的业务材料');
    assert.equal(m.pending().filter(w => w.kind !== 'cancel').length, 0);
    traces.push(`owner:${status}:waitingHuman:${m.c.outcome}`);
  }
  const map = new CapacityModel(); map.claim(); assert(map.interpret().ok);
  const works = map.pending('assistance').slice(0, 3);
  for (const work of works) assert(map.send({ type: 'CLAIM', intentId: work.id }).ok);
  const [first, second, third] = works.map(w => map.context.intents.find(i => i.id === w.id)!);
  assert(map.send({ type: 'DISCUSSION_RESULT', discussionId: first!.discussionId!, workId: first!.id, fence: first!,
    text: '已经完成的独立结果', status: 'success' }).ok);
  for (const work of [second!, third!]) {
    assert(map.send({ type: 'WORK_FAILED', intentId: work.id, fence: work, code: 'MODEL_HTTP_400',
      reason: 'Error: Model HTTP 400 (builder-2): invalid_request_error', transient: false }).ok);
  }
  assert.equal(taskPhase(map.snapshot), 'waitingHuman');
  const gates = map.context.resilience!.gates.filter(g => g.cause === 'modelServiceError' && g.status === 'open');
  assert.equal(gates.length, 2, 'Parallel errors must retain separate explicit decisions');
  assert(map.send({ type: 'HUMAN_GATE_DECISION', gateId: gates[0]!.id, decision: 'skip' }).ok);
  assert.equal(taskPhase(map.snapshot), 'waitingHuman');
  assert.equal(map.context.resilience!.gates.find(g => g.id === gates[1]!.id)!.status, 'open');
  assert(map.send({ type: 'HUMAN_GATE_DECISION', gateId: gates[1]!.id, decision: 'skip' }).ok);
  assert(map.context.discussion!.results.some(r => r.answer === '已经完成的独立结果'));
  assert.equal(map.context.discussion!.mapReduce!.queue!.find(p => p.workId === second!.id)!.status, 'cancelled');
  assert(map.context.intents.some(w => w.kind === 'assistance' && ['pending', 'inflight'].includes(w.status)), 'Other map work must remain available');
  traces.push('parallel-map:keep-success:two-explicit-skips:continue-rest');
  const parser = new CapacityModel(); parser.claim();
  assert(parser.send({ type: 'WORK_FAILED', intentId: parser.work.id, fence: parser.work,
    code: 'MODEL_HTTP_403', reason: 'Error: Model HTTP 403 (parser): permission_error', transient: false }).ok);
  assert.equal(parser.context.inputAnalyses![0]!.status, 'failed');
  assert.equal(taskHumanGate(parser.context)?.cause, 'modelServiceError');
  traces.push('interpretation:403:failed-input-and-explicit-gate');
  const expired = new ResilienceModel(); expired.artifact(); const failed = expired.claim();
  assert(expired.send({ type: 'WORK_FAILED', intentId: failed.id, fence: failed, code: 'MODEL_HTTP_403',
    reason: 'Error: Model HTTP 403 (A)', transient: false }).ok);
  expired.at = expired.c.resilience!.window.hardDeadline + 1;
  assert(expired.send({ type: 'HUMAN_GATE_DECISION', gateId: taskHumanGate(expired.c)!.id, decision: 'skip' }).ok);
  assert.equal(expired.phase, 'ended'); assert.equal(expired.c.outcome, 'partial');
  traces.push('expired-error-skip:consistent-ended-partial-without-extending-window');
  const transient = new ResilienceModel(); const work = transient.claim();
  assert(transient.send({ type: 'WORK_FAILED', intentId: work.id, fence: work,
    code: 'MODEL_HTTP_429', reason: 'Error: Model HTTP 429 (A): rate_limit_error', transient: true }).ok);
  assert.equal(taskHumanGate(transient.c), undefined); assert.equal(transient.pending().length, 1);
  traces.push('429:existing-transient-retry');
  return { traces };
}
if (process.argv[1]?.endsWith('model-service-error-model-fixture.ts')) console.log(JSON.stringify(verifyModelServiceErrorModel(), null, 2));
