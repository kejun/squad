import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner, type WorkAdapter } from '../src/runner.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';
import type { ExecutionObservation } from '../src/measurement.js';
import { Harness } from './helpers.js';
import { localConfig } from './local-tools-fixture.js';

/** Real adapter -> runner -> persisted task, with a controlled provider boundary and clock. */
export async function windowFailureTransport(failure: string) {
  const config = localConfig();
  config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2 };
  config.limits.workTimeoutMs = 20;
  const h = new Harness(config);
  const expired = failure.startsWith('WINDOW_EXPIRED');
  const singleTimeout = failure.includes('单次');
  const observations: ExecutionObservation[] = [];
  let requests = 0;
  const provider = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport: async () => {
    requests++;
    h.now = expired ? 100 : 2;
    throw new Error('controlled transport disconnect');
  } });
  const adapter: WorkAdapter = { execute: async (work, signal, scope) => {
    if (singleTimeout) h.now = work.deadline!;
    return provider.execute(work, signal, scope);
  } };
  const runner = new WorkRunner(h.engine, adapter, () => h.now, undefined, undefined, undefined,
    (_context, observation) => { if (observation.phase.startsWith('work.')) observations.push(observation as ExecutionObservation); });
  assert(await runner.runOne(h.room, h.task));
  const result = observations.find(item => item.phase === 'work.result');
  assert(result && result.phase === 'work.result');
  assert.equal(result.code, expired ? 'WINDOW_EXPIRED' : singleTimeout ? 'WORK_TIMEOUT' : 'MODEL_NETWORK_ERROR');
  assert.equal(requests, singleTimeout ? 0 : 1);
  if (expired) {
    assert.equal(h.view().phase, 'waitingHuman');
    assert.equal(h.context().outcome, null);
    assert.equal(processingWindow(h.context()).failure?.code, 'WINDOW_EXPIRED');
    assert.equal(taskHumanGate(h.context())?.cause, 'windowExpired');
    assert.equal(h.context().usage.retries, 0);
    assert.equal(h.engine.pending(h.room, h.task).filter(work => work.kind !== 'cancel').length, 0);
  } else if (singleTimeout) {
    assert.equal(h.context().usage.retries, 0);
    assert.equal(processingWindow(h.context()).failure, undefined);
    assert.notEqual(taskHumanGate(h.context())?.cause, 'windowExpired');
  } else {
    assert.equal(h.view().phase, 'running');
    assert.equal(h.context().usage.retries, 1);
    assert.equal(processingWindow(h.context()).failure, undefined);
  }
  return { code: result.code, requests, phase: h.view().phase, retries: h.context().usage.retries };
}
