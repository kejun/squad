import assert from 'node:assert/strict';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { checkReviewSources } from '../src/delivery-acceptance.js';
import type { Intent } from '../src/types.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';

/** Pure public-event driver; every transition round-trips the persisted XState snapshot. */
export class MapQueueModel extends CapacityModel {
  peak = 0;
  constructor() {
    super(input => { input.config.limits.retries = 4; });
    this.claim(); this.consume();
    const spec = capacityModelIntent();
    spec.decomposition!.partitions = Array.from({ length: 8 }, (_, i) => ({ id: `part-${i + 1}`, objective: `读取doc-${i + 1}`, expectedOutput: `doc-${i + 1}证据` }));
    assert(this.interpret(spec).ok);
    assert.equal(this.queue.length, 8); assert.equal(this.pending('assistance').length, 4);
  }
  get queue() { return this.context.discussion!.mapReduce!.queue!; }
  start(work = this.pending('assistance')[0]!) {
    assert(work); assert(this.send({ type: 'CLAIM', intentId: work.id }).ok);
    const claimed = this.context.intents.find(item => item.id === work.id)!;
    assert(this.send({ type: 'CONSUME', intentId: claimed.id, fence: claimed, attempt: claimed.attempt }).ok);
    const active = this.context.intents.filter(item => item.kind === 'assistance' && item.status === 'inflight');
    this.peak = Math.max(this.peak, active.length);
    assert(active.length <= 4); assert.equal(new Set(active.map(item => item.target)).size, active.length);
    return structuredClone(this.context.intents.find(item => item.id === work.id)!);
  }
  answer(work: Intent) {
    return this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, attempt: work.attempt,
      text: String((work.payload.partition as { id?: string } | undefined)?.id ?? '归并完成'), status: 'success' });
  }
  drain() {
    while (this.pending('assistance').length) assert(this.answer(this.start()).ok);
  }
  recover() { this.snapshot = restoreTask(persistTask(this.snapshot)); assert(this.send({ type: 'RECOVER', config: this.context.config }).ok); }
}

export function queueWaveGate() {
  const model = new MapQueueModel();
  const first = model.pending('assistance').map(work => model.start(work));
  assert.equal(model.peak, 4); assert.equal(model.pending('discussionSummary').length, 0);
  for (const work of first) assert(model.answer(work).ok);
  assert.equal(model.pending('assistance').length, 4); assert.equal(model.pending('discussionSummary').length, 0);
  model.drain(); assert(model.queue.every(part => part.status === 'succeeded' && part.attempt === 1));
  assert.equal(model.pending('discussionSummary').length, 1);
  assert(model.answer(model.start(model.pending('discussionSummary')[0]!)).ok);
  assert.equal(model.pending('owner').length, 1);
  const sources = checkReviewSources(model.context);
  assert.equal(sources.length, 8); assert.equal(new Set(sources.map(source => source.id)).size, 8);
  assert.deepEqual(sources.map(source => JSON.parse(source.content).partition.id).sort(), model.queue.map(part => part.partitionId).sort());
  model.recover(); assert.equal(model.context.intents.filter(work => work.kind === 'discussionSummary').length, 1);
  return model;
}

export function queueRetryGate() {
  const model = new MapQueueModel(), success = model.start(); assert(model.answer(success).ok);
  const failed = model.start();
  assert(model.send({ type: 'WORK_FAILED', intentId: failed.id, transient: true, reason: 'temporary transport failure' }).ok);
  const retry = model.pending('assistance').find(work => work.payload.partitionAttempt === 2)!;
  assert(retry); assert.equal(model.context.usage.retries, 1);
  assert.equal(model.answer(failed).ok, false);
  assert.equal(model.context.discussion!.results.filter(result => result.workId === success.id).length, 1);
  const second = model.start(retry);
  assert(model.send({ type: 'WORK_FAILED', intentId: second.id, transient: true, reason: 'temporary transport failure again' }).ok);
  model.drain();
  assert.equal(model.context.usage.retries, 1); assert.equal(model.queue.filter(part => part.status === 'failed').length, 1);
  assert.equal(model.context.discussion!.results.filter(result => result.status === 'failed').length, 2);
  assert(model.context.discussion!.incomplete?.includes('failed')); return model;
}

export function queueStopGate() {
  const model = new MapQueueModel(), done = model.start(); assert(model.answer(done).ok);
  model.start(); const assignments = model.context.discussion!.mapReduce!.assignments.length;
  model.recover(); assert.equal(model.queue[0]!.status, 'succeeded');
  assert(model.send({ type: 'STOP' }).ok); model.recover();
  assert.equal(model.queue.filter(part => part.status === 'queued').length, 0);
  assert.equal(model.pending('assistance').length, 0); assert.equal(model.pending('discussionSummary').length, 0);
  assert.equal(model.context.discussion!.mapReduce!.assignments.length, assignments); return model;
}

export function queueUnknownGate() {
  const model = new MapQueueModel(), work = model.start();
  assert(model.send({ type: 'WORK_FAILED', intentId: work.id, transient: true, resultUncertain: true, reason: 'unknown external outcome' }).ok);
  model.drain(); model.recover(); model.recover();
  assert.equal(model.queue[0]!.status, 'uncertain'); assert.equal(model.queue[0]!.attempt, 1);
  assert.equal(model.queue.filter(part => part.status === 'succeeded').length, 7);
  assert.equal(model.pending('assistance').length, 0); assert.equal(model.pending('discussionSummary').length, 0);
  assert.equal(model.context.usage.retries, 0); return model;
}

export function queueBudgetGate() {
  const model = new MapQueueModel();
  // Simulate a restored snapshot whose shared budget has been spent elsewhere.
  model.context.usage.ordinary = model.context.config.limits.ordinary - 5;
  model.recover();
  assert.equal(model.queue.filter(part => part.status === 'cancelled' && part.reason === 'MAP_BUDGET_EXHAUSTED').length, 4);
  assert.equal(model.context.outcome, null); assert.equal(model.pending('discussionSummary').length, 0);
  return model;
}

export function verifyMapQueueModel() {
  queueWaveGate(); queueRetryGate(); queueStopGate(); queueUnknownGate(); queueBudgetGate();
}
