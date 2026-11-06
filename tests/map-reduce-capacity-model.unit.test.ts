import { describe, expect, it } from 'vitest';
import { initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { InputIntentSpec, Intent, TaskEvent, TaskInput } from '../src/types.js';
import { localModelInput } from './local-model-fixture.js';

const documentIds = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5', 'doc-6', 'doc-7', 'doc-8'];
const groupedObjectives = ['汇总doc-1与doc-2', '汇总doc-3与doc-4', '汇总doc-5与doc-6', '汇总doc-7与doc-8'];
function groupedIntent(): InputIntentSpec {
  return { action: 'request', objective: '汇总全部八份文档', constraints: ['保留每份文档来源'], expectedOutputs: ['完整汇总报告'],
    acceptanceCriteria: ['八份文档各覆盖一次'], confidence: 1, clarification: null,
    references: documentIds.map(id => ({ kind: 'artifact', id, taskId: 'previous' })),
    decomposition: { kind: 'mapReduce', synthesis: '归并全部八份文档的结果，保留各文来源',
      partitions: groupedObjectives.map((objective, i) => ({ id: `group-${i + 1}`, objective, expectedOutput: '分组文档证据与来源' })) } };
}

type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;
class CapacityModel {
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
  claim() { expect(this.send({ type: 'CLAIM', intentId: this.work.id }).ok).toBe(true); return this.work; }
  consume() { expect(this.send({ type: 'CONSUME', intentId: this.work.id, fence: this.work, attempt: this.work.attempt }).ok).toBe(true); }
  interpret(spec = groupedIntent()) {
    return this.send({ type: 'INTERPRETATION_RESULT', workId: this.work.id, fence: this.work, attempt: this.work.attempt,
      inputId: (this.work.payload.input as { id: string }).id, spec });
  }
  busyMember() {
    this.context.intents.push({ id: 'busy-member', kind: 'assistance', target: 'B', payload: {}, status: 'uncertain',
      replay: 'safe', attempt: 1, deadline: null, bucket: 'ordinary', requestCount: 1, epoch: 1, goalVersion: 1 });
  }
  settleGroups() {
    for (const pending of this.pending('assistance')) {
      expect(this.send({ type: 'CLAIM', intentId: pending.id }).ok).toBe(true);
      const work = this.context.intents.find(item => item.id === pending.id)!;
      expect(this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work,
        text: `${work.target}的完整分组证据`, status: 'success' }).ok).toBe(true);
    }
  }
}

describe('map-reduce capacity in the real task model', () => {
  it('[BT_Q07] advertises four partitions after the interpretation charge and assigns every complete group', () => {
    const model = new CapacityModel();
    expect(model.work.payload.maxPartitions).toBe(4);
    model.claim(); model.consume();

    expect(model.work.payload.maxPartitions).toBe(4);
    expect(model.context.usage.ordinary).toBe(1);
    expect(model.interpret().ok).toBe(true);

    expect(model.pending('assistance').map(work => work.payload.partition)).toEqual(groupedIntent().decomposition!.partitions);
    expect(model.context.discussion!.mapReduce!.synthesis).toBe('归并全部八份文档的结果，保留各文来源');
    expect(model.pending('assistance')[0]!.payload.inputIntents).toContainEqual(expect.objectContaining({ spec: groupedIntent() }));
    expect(model.pending('owner')).toEqual([]);
    model.settleGroups();
    const summary = model.pending('discussionSummary')[0]!;
    expect(model.pending('discussionSummary')).toHaveLength(1);
    expect(model.send({ type: 'CLAIM', intentId: summary.id }).ok).toBe(true);
    const claimedSummary = model.context.intents.find(work => work.id === summary.id)!;
    expect(model.send({ type: 'DISCUSSION_RESULT', discussionId: claimedSummary.discussionId!, workId: claimedSummary.id,
      fence: claimedSummary, text: '归并所有八份文档的证据与来源', status: 'success' }).ok).toBe(true);
    expect(model.pending('owner')).toHaveLength(1);
    expect(model.pending('owner')[0]!.payload.discussion).toMatchObject({ results: [
      { target: 'B' }, { target: 'C' }, { target: 'D' }, { target: 'E' },
    ] });
  });

  it.each([
    ['四名可用成员', () => {}, 4],
    ['剩余两次协助', (input: TaskInput) => { input.config.limits.assists = 2; }, 2],
    ['普通额度只够三片及归并续办', (input: TaskInput) => { input.config.limits.ordinary = 6; }, 3],
    ['本次理解后只够一片', (input: TaskInput) => { input.config.limits.ordinary = 4; }, 1],
    ['本次理解后不足一片', (input: TaskInput) => { input.config.limits.ordinary = 2; }, 0],
    ['资源充足仍受协议上限约束', (input: TaskInput) => {
      input.config.bots.push(...['F', 'G', 'H', 'I', 'J', 'K'].map(id => ({ id, name: id, instructions: '', tools: [] })));
    }, 8],
  ] as const)('[BT_Q08] snapshots the same capacity before and after the claim for %s', (_label, change, maximum) => {
    const model = new CapacityModel(change);
    expect(model.work.payload.maxPartitions).toBe(maximum);

    model.claim(); model.consume();

    expect(model.work.payload.maxPartitions).toBe(maximum);
    expect(model.context.usage.ordinary).toBe(1);
    expect(model.context.usage.assists).toBe(0);
  });

  it('[BT_Q08] excludes a busy non-owner when refreshing the claimed capacity', () => {
    const model = new CapacityModel(); model.busyMember();

    model.claim();

    expect(model.work.payload.maxPartitions).toBe(3);
  });

  it('[BT_Q08] refreshes capacity on every retried claim after charging that request', () => {
    const model = new CapacityModel(input => { input.config.limits.ordinary = 6; });
    model.claim(); model.consume();
    expect(model.work.payload.maxPartitions).toBe(3);
    expect(model.send({ type: 'WORK_FAILED', intentId: model.work.id, transient: true, reason: 'temporary transport failure' }).ok).toBe(true);

    model.claim(); model.consume();

    expect(model.work.payload.maxPartitions).toBe(2);
    expect(model.context.usage.ordinary).toBe(2);
  });

  it.each([0, 1])('[BT_Q09] preserves all eight references for owner when capacity is %s and decomposition is omitted', maximum => {
    const model = new CapacityModel(input => { input.config.limits.ordinary = maximum + 3; });
    const spec = groupedIntent(); delete spec.decomposition;
    model.claim(); model.consume();
    expect(model.work.payload.maxPartitions).toBe(maximum);

    expect(model.interpret(spec).ok).toBe(true);

    expect(model.pending('assistance')).toEqual([]);
    expect(model.pending('owner')[0]!.payload.inputIntents).toContainEqual(expect.objectContaining({ spec }));
    expect(model.pending('owner')[0]!.payload.conversation).toMatchObject({ artifacts: model.context.history!.artifacts });
  });

  it.each([
    ['成员忙碌', (model: CapacityModel) => model.busyMember(), '可用成员不足'],
    ['协助余额降低', (model: CapacityModel) => { model.context.usage.assists = 17; }, '协助额度不足'],
    ['普通余额降低', (model: CapacityModel) => { model.context.usage.ordinary = 25; }, '普通额度不足'],
  ] as const)('[BT_Q11] falls back with the entire plan after %s without partial dispatch', (_label, decrease, reason) => {
    const model = new CapacityModel(); model.claim(); model.consume();
    expect(model.work.payload.maxPartitions).toBe(4);
    decrease(model); const before = structuredClone(model.context.usage);

    expect(model.interpret().ok).toBe(true);

    expect(model.context.discussion).toBeUndefined();
    expect(model.pending('assistance')).toEqual([]);
    expect(model.pending('owner')[0]!.payload.inputIntents).toContainEqual(expect.objectContaining({ spec: groupedIntent() }));
    expect(model.context.messages.at(-1)!.text).toContain(reason);
    expect(model.context.usage).toEqual(before);
  });

  it.each([false, true])('[BT_Q12] restores historical work without maxPartitions and applies the current guard (limited=%s)', limited => {
    const model = new CapacityModel(); model.claim(); model.consume(); delete model.work.payload.maxPartitions;
    model.snapshot = restoreTask(structuredClone(persistTask(model.snapshot)));
    if (limited) model.context.usage.assists = 17;

    expect(model.interpret().ok).toBe(true);

    expect(model.context.inputAnalyses![0]!.decompositionApplied).toBe(true);
    expect(model.context.inputAnalyses![0]!.spec).toEqual(groupedIntent());
    expect(model.pending('assistance')).toHaveLength(limited ? 0 : 4);
    expect(model.pending('owner')).toHaveLength(limited ? 1 : 0);
  });

  it('[BT_Q12] preserves the missing capacity on historical pending work through recovery and claim', () => {
    const model = new CapacityModel(); delete model.work.payload.maxPartitions;
    model.snapshot = restoreTask(structuredClone(persistTask(model.snapshot)));
    expect(model.send({ type: 'RECOVER', config: model.context.config }).ok).toBe(true);

    model.claim(); model.consume();

    expect(model.work.payload).not.toHaveProperty('maxPartitions');
    expect(model.interpret().ok).toBe(true);
    expect(model.pending('assistance')).toHaveLength(4);
  });
});
