import assert from 'node:assert/strict';
import { debugInput } from '../src/task-debug.js';
import { executionState, initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { InputIntentSpec, Intent, TaskEvent, TaskInput } from '../src/types.js';

export const modelMapIntent = (): InputIntentSpec => ({ action: 'request', objective: '比较甲乙两个来源并汇总', constraints: ['仅使用公开资料'],
  expectedOutputs: ['对比报告'], acceptanceCriteria: ['标明每个来源'], references: [], confidence: .95, clarification: null,
  decomposition: { kind: 'mapReduce', partitions: [
    { id: 'alpha', objective: '研究甲来源', expectedOutput: '甲证据' },
    { id: 'beta', objective: '研究乙来源', expectedOutput: '乙证据' },
  ], synthesis: '对比两份证据，明确未知与分歧' } });
type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;

/** Pure XState gate, run for the matching scenario before its engine/runner wiring. */
export class MapModel {
  snapshot: TaskSnapshot; sequence = 0;
  constructor(change: (input: TaskInput) => void = () => {}) {
    const input = debugInput();
    input.message.text = '分别研究甲乙两个来源，必须仅使用公开资料并汇总';
    input.goal = { text: input.message.text, constraints: ['仅使用公开资料'], criteria: ['标明每个来源'], requiredArtifacts: 0 };
    input.config.inputAnalysis = { enabled: true };
    input.config.bots.push({ id: 'builder-1', name: 'Builder', instructions: '独立研究', tools: [] });
    input.config.models = { default: 'test', services: { test: { baseUrl: 'https://invalid.example/v1', model: 'test' } } };
    change(input); this.snapshot = initialTask(input);
  }
  get context() { return this.snapshot.context; }
  send(body: Body) { this.snapshot = stepTask(this.snapshot, { ...body, id: `map:${++this.sequence}`, at: this.sequence } as TaskEvent); return this.context.reply; }
  pending(kind: Intent['kind']) { return this.context.intents.filter(work => work.kind === kind && work.status === 'pending'); }
  claim(work: Intent) { assert(this.send({ type: 'CLAIM', intentId: work.id }).ok); return this.context.intents.find(item => item.id === work.id)!; }
  interpret(value = modelMapIntent()) {
    const work = this.claim(this.pending('interpretation')[0]!);
    assert(this.send({ type: 'INTERPRETATION_RESULT', inputId: (work.payload.input as { id: string }).id, workId: work.id, fence: work, spec: value }).ok);
  }
  answer(work: Intent, status: 'success' | 'partial' = 'success') {
    return this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, text: `${work.target} 原始证据`, status });
  }
}

export function parallelMapModelGate() {
  const model = new MapModel(); model.interpret();
  const first = model.claim(model.pending('assistance')[0]!), second = model.claim(model.pending('assistance')[0]!);
  assert.deepEqual(model.context.intents.filter(work => work.status === 'inflight').map(work => work.target), ['B', 'builder-1']);
  assert.equal(executionState(model.snapshot, first.id, first.attempt), 'authorized');
  assert.equal(executionState(model.snapshot, second.id, second.attempt), 'authorized');
  assert.deepEqual(model.context.discussion!.mapReduce!.assignments, [{ partitionId: 'alpha', target: 'B' }, { partitionId: 'beta', target: 'builder-1' }]);
  assert.deepEqual(first.payload.partition, modelMapIntent().decomposition!.partitions[0]);
  assert.deepEqual(second.payload.partition, modelMapIntent().decomposition!.partitions[1]);
  assert.deepEqual((first.payload.goal as TaskInput['goal']).constraints, ['仅使用公开资料']);
  assert.equal(model.pending('owner').length, 0);
  assert(model.answer(second).ok); assert.equal(model.pending('discussionSummary').length, 0);
  assert(model.answer(first).ok); assert.equal(model.pending('discussionSummary').length, 1);
  assert(model.answer(model.claim(model.pending('discussionSummary')[0]!)).ok);
  assert.equal(model.pending('owner').length, 1);
  const round = model.pending('owner')[0]!.payload.discussion as { status: string; results: { target: string }[] };
  assert.equal(round.status, 'delivered'); assert.deepEqual(round.results.map(result => result.target), ['builder-1', 'B']);
}
export function limitedMapModelGate(limit: string) {
  const model = new MapModel(input => {
    if (limit === '普通额度不足') input.config.limits.ordinary = 4;
    else if (limit === '协助额度不足') input.config.limits.assists = 1;
    else if (limit === '可用成员不足') input.config.bots = input.config.bots.slice(0, 2);
    else assert.fail(`Unknown limit ${limit}`);
  }); model.interpret();
  assert.equal(model.pending('assistance').length, 0); assert.equal(model.pending('owner').length, 1);
  assert(model.context.messages.at(-1)!.text.includes('未启动并行分片')); assert.equal(model.context.usage.assists, 0);
}
export function partialMapModelGate() {
  const model = new MapModel(); model.interpret();
  assert(model.answer(model.claim(model.pending('assistance')[0]!), 'partial').ok);
  assert(model.answer(model.claim(model.pending('assistance')[0]!)).ok);
  assert(model.answer(model.claim(model.pending('discussionSummary')[0]!)).ok);
  assert(model.context.discussion!.incomplete?.includes('未完整完成'), 'Partial map evidence must survive a successful reduce');
  const round = model.pending('owner')[0]!.payload.discussion as { results: { status: string }[] };
  assert.deepEqual(round.results.map(result => result.status), ['partial', 'success']);
}
export function changedMapModelGate(change: string) {
  const model = new MapModel(); model.interpret(); const work = model.claim(model.pending('assistance')[0]!);
  assert(model.send(change === '停止' ? { type: 'STOP' } : { type: 'USER_INPUT', text: '新目标', goal: { ...model.context.goal, text: '新目标' } }).ok);
  assert.equal(model.answer(work).ok, false); assert.equal(model.context.discussion!.status, 'cancelled');
  assert.equal(model.pending('discussionSummary').length, 0);
}
export function restoredMapModelGate() {
  const model = new MapModel(); model.interpret(); const work = model.claim(model.pending('assistance')[0]!); assert(model.answer(work).ok);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert.equal(model.context.discussion!.results.length, 1); assert.equal(model.pending('assistance').length, 1);
  assert.equal(model.answer(work).ok, false); assert(model.answer(model.claim(model.pending('assistance')[0]!)).ok);
  assert.equal(model.pending('discussionSummary').length, 1);
}
export function ordinaryMapModelGate() {
  const model = new MapModel(); const ordinary = modelMapIntent(); delete ordinary.decomposition; model.interpret(ordinary);
  assert.equal(model.pending('owner').length, 1); assert.equal(model.pending('assistance').length, 0);
}
export function supplementMapModelGate() {
  const model = new MapModel(); const ordinary = modelMapIntent(); delete ordinary.decomposition; model.interpret(ordinary);
  assert(model.send({ type: 'USER_INPUT', text: '分别研究甲乙两个来源并汇总' }).ok);
  model.interpret({ ...modelMapIntent(), action: 'supplement' });
  assert.equal(model.pending('assistance').length, 2); assert.equal(model.pending('owner').length, 0);
  assert.equal(model.context.inputAnalyses!.at(-1)!.decompositionApplied, true);
}
