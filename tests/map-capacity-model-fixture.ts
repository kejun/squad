import assert from 'node:assert/strict';
import { initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { InputIntentSpec, Intent, TaskEvent, TaskInput } from '../src/types.js';
import { localModelInput } from './local-model-fixture.js';

const documentIds = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5', 'doc-6', 'doc-7', 'doc-8'];
const groupedObjectives = ['汇总doc-1与doc-2', '汇总doc-3与doc-4', '汇总doc-5与doc-6', '汇总doc-7与doc-8'];
export function capacityModelIntent(): InputIntentSpec {
  return { action: 'request', objective: '汇总全部八份文档', constraints: ['保留每份文档来源'], expectedOutputs: ['完整汇总报告'],
    acceptanceCriteria: ['八份文档各覆盖一次'], confidence: 1, clarification: null,
    references: documentIds.map(id => ({ kind: 'artifact', id, taskId: 'previous' })),
    decomposition: { kind: 'mapReduce', synthesis: '归并全部八份文档的结果，保留各文来源',
      partitions: groupedObjectives.map((objective, i) => ({ id: `group-${i + 1}`, objective, expectedOutput: '分组文档证据与来源' })) } };
}

type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;
export class CapacityModel {
  snapshot: TaskSnapshot; sequence = 0;
  constructor(change: (input: TaskInput) => void = () => {}) {
    const input = localModelInput();
    input.message.text = '请分别阅读八份文档；必须保留全部来源；最后合并汇总';
    input.goal = { text: input.message.text, constraints: ['保留每份文档来源'], criteria: ['八份文档各覆盖一次'], requiredArtifacts: 0 };
    input.config.inputAnalysis = { enabled: true };
    input.config.models = { default: 'test', services: { test: { baseUrl: 'https://example.test/v1', model: 'test' } } };
    input.config.bots.push(...['C', 'D', 'E'].map(id => ({ id, name: id, instructions: '', tools: [] })));
    input.config.limits.ordinary = 30; input.config.limits.assists = 20;
    input.history = { messages: [], board: [], truncated: false,
      artifacts: documentIds.map(id => ({ id, taskId: 'previous', name: `${id}.md`, content: `${id}正文与来源`, goalVersion: 1 })) };
    change(input); this.snapshot = initialTask(input);
  }
  get context() { return this.snapshot.context; }
  get work() { return this.context.intents.find(work => work.kind === 'interpretation')!; }
  pending(kind: Intent['kind']) { return this.context.intents.filter(work => work.kind === kind && work.status === 'pending'); }
  send(body: Body) {
    this.snapshot = stepTask(this.snapshot, { id: `capacity:${++this.sequence}`, at: this.sequence, ...body } as TaskEvent);
    this.snapshot = restoreTask(structuredClone(persistTask(this.snapshot)));
    return this.context.reply;
  }
  claim() { assert(this.send({ type: 'CLAIM', intentId: this.work.id }).ok); return this.work; }
  consume() { assert(this.send({ type: 'CONSUME', intentId: this.work.id, fence: this.work, attempt: this.work.attempt }).ok); }
  interpret(spec = capacityModelIntent()) {
    return this.send({ type: 'INTERPRETATION_RESULT', workId: this.work.id, fence: this.work, attempt: this.work.attempt,
      inputId: (this.work.payload.input as { id: string }).id, spec });
  }
  busyMember() {
    this.context.intents.push({ id: 'busy-member', kind: 'assistance', target: 'B', payload: {}, status: 'uncertain',
      replay: 'safe', attempt: 1, deadline: null, bucket: 'ordinary', requestCount: 1, epoch: 1, goalVersion: 1 });
  }
  settleGroups() {
    for (const pending of this.pending('assistance')) {
      assert(this.send({ type: 'CLAIM', intentId: pending.id }).ok);
      const work = this.context.intents.find(item => item.id === pending.id)!;
      assert(this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work,
        text: `${work.target}的完整分组证据`, status: 'success' }).ok);
    }
  }
}

/** Scenario-specific pure gates run before the corresponding integration fixture. */
export function completeCapacityModelGate() {
  const model = new CapacityModel(); assert.equal(model.work.payload.maxPartitions, 4);
  model.claim(); model.consume(); assert.equal(model.work.payload.maxPartitions, 4); assert.equal(model.context.usage.ordinary, 1);
  assert(model.interpret().ok);
  assert.deepEqual(model.pending('assistance').map(work => work.payload.partition), capacityModelIntent().decomposition!.partitions);
  assert.equal(model.context.discussion!.mapReduce!.synthesis, capacityModelIntent().decomposition!.synthesis);
  assert.deepEqual((model.pending('assistance')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, capacityModelIntent());
  assert.equal(model.pending('owner').length, 0); model.settleGroups();
  assert.equal(model.pending('discussionSummary').length, 1);
  const summary = model.pending('discussionSummary')[0]!;
  assert(model.send({ type: 'CLAIM', intentId: summary.id }).ok);
  const claimed = model.context.intents.find(work => work.id === summary.id)!;
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: claimed.discussionId!, workId: claimed.id, fence: claimed,
    text: '归并所有八份文档的证据与来源', status: 'success' }).ok);
  assert.equal(model.pending('owner').length, 1);
  const round = model.pending('owner')[0]!.payload.discussion as { results: { target: string }[] };
  assert.deepEqual(round.results.map(result => result.target), ['B', 'C', 'D', 'E']);
}
export function snapshotCapacityModelGate(limit: string, maximum: number) {
  const model = new CapacityModel(input => {
    if (limit === '剩余两次协助') input.config.limits.assists = 2;
    else if (limit === '普通额度只够三片及归并续办') input.config.limits.ordinary = 6;
    else if (limit === '本次理解后只够一片') input.config.limits.ordinary = 4;
    else if (limit === '本次理解后不足一片') input.config.limits.ordinary = 2;
    else if (limit === '资源充足仍受协议上限约束') input.config.bots.push(...['F', 'G', 'H', 'I', 'J', 'K'].map(id => ({ id, name: id, instructions: '', tools: [] })));
  });
  if (limit === '仅三名空闲成员') model.busyMember();
  if (limit !== '仅三名空闲成员') assert.equal(model.work.payload.maxPartitions, maximum);
  model.claim(); model.consume();
  assert.equal(model.work.payload.maxPartitions, maximum); assert.equal(model.context.usage.ordinary, 1); assert.equal(model.context.usage.assists, 0);
}
export function retriedCapacityModelGate() {
  const model = new CapacityModel(input => { input.config.limits.ordinary = 6; }); model.claim(); model.consume();
  assert.equal(model.work.payload.maxPartitions, 3);
  assert(model.send({ type: 'WORK_FAILED', intentId: model.work.id, transient: true, reason: 'temporary transport failure' }).ok);
  model.claim(); model.consume(); assert.equal(model.work.payload.maxPartitions, 2); assert.equal(model.context.usage.ordinary, 2);
}
export function ordinaryCapacityModelGate(maximum: number) {
  const model = new CapacityModel(input => { input.config.limits.ordinary = maximum + 3; });
  const spec = capacityModelIntent(); delete spec.decomposition; model.claim(); model.consume(); assert.equal(model.work.payload.maxPartitions, maximum);
  assert(model.interpret(spec).ok); assert.equal(model.pending('assistance').length, 0);
  assert.deepEqual((model.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, spec);
  assert.deepEqual((model.pending('owner')[0]!.payload.conversation as { artifacts: unknown }).artifacts, model.context.history!.artifacts);
}
export function decreasedCapacityModelGate(change: string) {
  const model = new CapacityModel(); model.claim(); model.consume(); assert.equal(model.work.payload.maxPartitions, 4);
  const reasons: Record<string, string> = { 成员忙碌: '可用成员不足', 协助余额降低: '协助额度不足', 普通余额降低: '普通额度不足' };
  if (change === '成员忙碌') model.busyMember();
  else if (change === '协助余额降低') model.context.usage.assists = 17;
  else if (change === '普通余额降低') model.context.usage.ordinary = 25;
  else assert.fail(`Unknown capacity change ${change}`);
  const before = structuredClone(model.context.usage); assert(model.interpret().ok);
  assert.equal(model.context.discussion, undefined); assert.equal(model.pending('assistance').length, 0);
  assert.deepEqual((model.pending('owner')[0]!.payload.inputIntents as { spec: unknown }[])[0]!.spec, capacityModelIntent());
  assert(model.context.messages.at(-1)!.text.includes(reasons[change]!)); assert.deepEqual(model.context.usage, before);
}
export function historicalCapacityModelGate(limited: boolean) {
  const model = new CapacityModel(); model.claim(); model.consume(); delete model.work.payload.maxPartitions;
  model.snapshot = restoreTask(structuredClone(persistTask(model.snapshot))); if (limited) model.context.usage.assists = 17;
  assert(model.interpret().ok); assert.equal(model.context.inputAnalyses![0]!.decompositionApplied, true);
  assert.deepEqual(model.context.inputAnalyses![0]!.spec, capacityModelIntent());
  assert.equal(model.pending('assistance').length, limited ? 0 : 4); assert.equal(model.pending('owner').length, limited ? 1 : 0);
}
export function pendingHistoricalCapacityModelGate() {
  const model = new CapacityModel(); delete model.work.payload.maxPartitions; model.snapshot = restoreTask(structuredClone(persistTask(model.snapshot)));
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok); model.claim(); model.consume();
  assert(!Object.hasOwn(model.work.payload, 'maxPartitions')); assert(model.interpret().ok); assert.equal(model.pending('assistance').length, 4);
}

