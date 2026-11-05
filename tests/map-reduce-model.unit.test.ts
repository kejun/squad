import { describe, expect, it } from 'vitest';
import { debugInput } from '../src/task-debug.js';
import { executionState, initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import { inputIntentSchema } from '../src/input-intent.js';
import type { InputIntentSpec, Intent, TaskEvent, TaskInput } from '../src/types.js';

const spec = (): InputIntentSpec => ({ action: 'request', objective: '比较甲乙两个来源并汇总', constraints: ['仅使用公开资料'],
  expectedOutputs: ['对比报告'], acceptanceCriteria: ['标明每个来源'], references: [], confidence: 0.95, clarification: null,
  decomposition: { kind: 'mapReduce', partitions: [
    { id: 'alpha', objective: '研究甲来源', expectedOutput: '甲证据' },
    { id: 'beta', objective: '研究乙来源', expectedOutput: '乙证据' },
  ], synthesis: '对比两份证据，明确未知与分歧' } });
type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;
class Model {
  snapshot: TaskSnapshot;
  sequence = 0;
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
  send(body: Body) {
    this.snapshot = stepTask(this.snapshot, { ...body, id: `map:${++this.sequence}`, at: this.sequence } as TaskEvent);
    return this.context.reply;
  }
  pending(kind: Intent['kind']) { return this.context.intents.filter(w => w.kind === kind && w.status === 'pending'); }
  claim(work: Intent) { this.send({ type: 'CLAIM', intentId: work.id }); return this.context.intents.find(w => w.id === work.id)!; }
  interpret(value = spec()) {
    const work = this.claim(this.pending('interpretation')[0]!);
    return this.send({ type: 'INTERPRETATION_RESULT', inputId: (work.payload.input as { id: string }).id, workId: work.id, fence: work, spec: value });
  }
  answer(work: Intent, status: 'success' | 'partial' = 'success') {
    return this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, text: `${work.target} 原始证据`, status });
  }
}

describe('map-reduce uses the persisted XState discussion lane', () => {
  it('[BT_Q01] should create separate concurrent execution actors before either partition returns', () => {
    const m = new Model(); m.interpret();
    const first = m.claim(m.pending('assistance')[0]!);
    const second = m.claim(m.pending('assistance')[0]!);
    expect(m.context.reply.ok).toBe(true);
    expect(m.context.intents.filter(w => w.status === 'inflight').map(w => w.target)).toEqual(['B', 'builder-1']);
    expect(executionState(m.snapshot, first.id, first.attempt)).toBe('authorized');
    expect(executionState(m.snapshot, second.id, second.attempt)).toBe('authorized');
    expect(m.context.discussion?.mapReduce?.assignments).toEqual([{ partitionId: 'alpha', target: 'B' }, { partitionId: 'beta', target: 'builder-1' }]);
    expect(first.payload.partition).toMatchObject({ id: 'alpha', objective: '研究甲来源' });
    expect(second.payload.partition).toMatchObject({ id: 'beta', objective: '研究乙来源' });
    expect(first.payload.goal).toMatchObject({ constraints: ['仅使用公开资料'] });
    expect(m.pending('owner')).toEqual([]);
    m.answer(second);
    expect(m.pending('discussionSummary')).toEqual([]);
    m.answer(first);
    expect(m.pending('discussionSummary')).toHaveLength(1);
    m.answer(m.claim(m.pending('discussionSummary')[0]!));
    expect(m.pending('owner')).toHaveLength(1);
    expect(m.pending('owner')[0]!.payload.discussion).toMatchObject({ status: 'delivered', results: [{ target: 'builder-1' }, { target: 'B' }] });
  });
  it.each([
    ['ordinary', (input: TaskInput) => { input.config.limits.ordinary = 4; }],
    ['assists', (input: TaskInput) => { input.config.limits.assists = 1; }],
    ['members', (input: TaskInput) => { input.config.bots = input.config.bots.slice(0, 2); }],
  ] as const)('[BT_Q02] should preserve the entire plan for owner when %s cannot cover all partitions', (_limit, change) => {
    const m = new Model(change);
    m.interpret();
    expect(m.pending('assistance')).toEqual([]);
    expect(m.pending('owner')).toHaveLength(1);
    expect(m.context.messages.at(-1)?.text).toContain('未启动并行分片');
    expect(m.context.usage.assists).toBe(0);
  });
  it('[BT_Q03] should preserve partial map evidence even if the reducer claims success', () => {
    const m = new Model(); m.interpret();
    m.answer(m.claim(m.pending('assistance')[0]!), 'partial');
    m.answer(m.claim(m.pending('assistance')[0]!));
    m.answer(m.claim(m.pending('discussionSummary')[0]!));
    expect(m.context.discussion?.incomplete).toContain('未完整完成');
    expect(m.pending('owner')[0]!.payload.discussion).toMatchObject({ results: [{ status: 'partial' }, { status: 'success' }] });
  });
  it.each([
    ['stop', (m: Model) => m.send({ type: 'STOP' })],
    ['goal', (m: Model) => m.send({ type: 'USER_INPUT', text: '新目标', goal: { ...m.context.goal, text: '新目标' } })],
  ] as const)('[BT_Q04] should reject late map results after %s', (_label, change) => {
    const m = new Model(); m.interpret(); const work = m.claim(m.pending('assistance')[0]!);
    change(m);
    expect(m.answer(work).ok).toBe(false);
    expect(m.context.discussion?.status).toBe('cancelled');
    expect(m.pending('discussionSummary')).toEqual([]);
  });
  it('[BT_Q05] should restore saved partition results without recreating completed work', () => {
    const m = new Model(); m.interpret(); const work = m.claim(m.pending('assistance')[0]!); m.answer(work);
    m.snapshot = restoreTask(persistTask(m.snapshot));
    expect(m.context.discussion?.results).toHaveLength(1);
    expect(m.pending('assistance')).toHaveLength(1);
    expect(m.answer(work).ok).toBe(false);
    m.answer(m.claim(m.pending('assistance')[0]!));
    expect(m.pending('discussionSummary')).toHaveLength(1);
  });
  it('[BT_Q01] should apply a supplement decomposition at the safe input boundary once', () => {
    const m = new Model(); const ordinary = spec(); delete ordinary.decomposition; m.interpret(ordinary);
    m.send({ type: 'USER_INPUT', text: '分别研究甲乙两个来源并汇总' });
    m.interpret({ ...spec(), action: 'supplement' });
    expect(m.pending('assistance')).toHaveLength(2);
    expect(m.pending('owner')).toEqual([]);
    expect(m.context.inputAnalyses?.at(-1)?.decompositionApplied).toBe(true);
  });
  it('[BT_Q06] should reject duplicate partition identities and model-selected members', () => {
    const duplicate = spec(); duplicate.decomposition!.partitions[1]!.id = 'alpha';
    const selected = spec(); Object.assign(selected.decomposition!.partitions[0]!, { target: 'A' });
    expect(inputIntentSchema.safeParse(duplicate).success).toBe(false);
    expect(inputIntentSchema.safeParse(selected).success).toBe(false);
  });
  it('[BT_Q06] should keep the legacy owner path when no decomposition is supplied', () => {
    const m = new Model(); const ordinary = spec(); delete ordinary.decomposition; m.interpret(ordinary);
    expect(m.pending('owner')).toHaveLength(1);
    expect(m.pending('assistance')).toEqual([]);
  });
});
