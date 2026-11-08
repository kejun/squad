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
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
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

export type RecoveryWork = '并行分片' | '后台讨论';
export type RecoveryChange = '修改目标' | '停止后继续';
export interface DiscussionRecoveryCase {
  model: MapModel; works: Intent[]; roundId: string; change: RecoveryChange; usage: MapModel['context']['usage'];
}

function startedDiscussionModel(kind: RecoveryWork) {
  const model = new MapModel();
  if (kind === '并行分片') model.interpret();
  else {
    const ordinary = modelMapIntent(); delete ordinary.decomposition; model.interpret(ordinary);
    model.claim(model.pending('owner')[0]!);
    assert(model.send({ type: 'USER_INPUT', text: '请大家讨论', reviewTargets: ['B', 'builder-1'] }).ok);
    const planner = model.claim(model.pending('facilitator')[0]!);
    assert(model.send({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId!,
      decision: { action: 'review', question: '核对来源', expected: '原始依据', reason: '用户直接邀请' } }).ok);
  }
  const works = [model.claim(model.pending('assistance')[0]!), model.claim(model.pending('assistance')[0]!)];
  const roundId = model.context.discussion!.id;
  return { model, works, roundId };
}

/** Shared scenario driver. All transitions use the real taskMachine, with no store or adapter. */
export function prepareDiscussionRecoveryModel(kind: RecoveryWork, change: RecoveryChange): DiscussionRecoveryCase {
  const { model, works, roundId } = startedDiscussionModel(kind);
  assert(model.send(change === '停止后继续' ? { type: 'STOP' }
    : { type: 'USER_INPUT', text: '新目标', goal: { ...model.context.goal, text: '新目标' } }).ok);
  assert.equal(model.context.discussion!.status, 'cancelled');
  assert(works.every(work => model.context.intents.find(item => item.id === work.id)!.status === 'inflight'),
    'Sending cancellation alone must not settle a live request');
  return { model, works, roundId, change, usage: structuredClone(model.context.usage) };
}

export function recoverDiscussionModel(state: DiscussionRecoveryCase) {
  const { model } = state;
  const config = structuredClone(model.context.config);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config }).ok);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config }).ok);
  assert.deepEqual(model.context.usage, state.usage, 'Recovery must not charge or restart the old discussion');
  assert(state.works.every(work => ['done', 'cancelled'].includes(model.context.intents.find(item => item.id === work.id)!.status)),
    'Abandoned safe discussion work must settle instead of occupying members after recovery');
  assert.equal(model.pending('discussionSummary').length, 0);
  if (state.change === '停止后继续') assert(model.send({ type: 'CONTINUE' }).ok);
}

export function inviteRecoveredMembersModel(state: DiscussionRecoveryCase) {
  const { model, works } = state;
  model.claim(model.pending('owner')[0]!);
  assert(model.send({ type: 'USER_INPUT', text: '请大家再讨论', reviewTargets: works.map(work => work.target) }).ok);
  assert.deepEqual(model.context.discussion!.targets, ['B', 'builder-1']);
  assert.deepEqual(model.context.discussion!.skipped, []);
  const planner = model.claim(model.pending('facilitator')[0]!);
  assert(model.send({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId!,
    decision: { action: 'review', question: '重新核对', expected: '当前依据', reason: '当前目标邀请' } }).ok);
  const first = model.claim(model.pending('assistance')[0]!), second = model.claim(model.pending('assistance')[0]!);
  assert.deepEqual([first.target, second.target], ['B', 'builder-1']);
  const current = structuredClone(model.context.discussion), usage = structuredClone(model.context.usage);
  assert.equal(model.answer(works[0]!).ok, false);
  assert.deepEqual(model.context.discussion, current, 'An old reply cannot change the new round');
  assert.deepEqual(model.context.usage, usage);
  assert.equal(model.context.intents.filter(work => work.discussionId === state.roundId && work.kind === 'discussionSummary').length, 0);
}

export function cancelledDiscussionModelGate(kind: RecoveryWork, change: RecoveryChange) {
  const state = prepareDiscussionRecoveryModel(kind, change);
  recoverDiscussionModel(state); inviteRecoveredMembersModel(state);
}

export function historicalCancelledDiscussionModelGate() {
  const state = prepareDiscussionRecoveryModel('并行分片', '修改目标');
  // This is the persisted shape produced by the pre-KEJ-106 RECOVER regression.
  const saved = persistTask(state.model.snapshot) as { context: MapModel['context'] };
  for (const work of saved.context.intents) if (state.works.some(old => old.id === work.id)) work.status = 'pending';
  state.model.snapshot = restoreTask(saved);
  recoverDiscussionModel(state); inviteRecoveredMembersModel(state);
}

export type PhysicalStage = '已领取' | '已启动' | '已退出但效果未知';
export function preparePhysicalDiscussionModel(stage: PhysicalStage) {
  const state = startedDiscussionModel('并行分片'), { model, works } = state;
  const work = works[0]!, operationId = `${work.id}:local:0`, sessionId = 'discussion-command-session';
  assert(model.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['-e', 'console.log(1)'] }, parentAttempt: work.attempt,
    workspaceId: 'workspace', messages: [], fence: work }).ok);
  assert(model.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, parentAttempt: work.attempt, sessionId,
    leaseAvailable: true, fence: work }).ok);
  if (stage !== '已领取') assert(model.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId, sessionId,
    workspaceRevision: 'revision', isolated: true }).ok);
  if (stage === '已退出但效果未知') assert(model.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId, sessionId,
    result: { ok: false, code: 'cancelled', data: {} }, settled: true, effectsKnown: false }).ok);
  return { ...state, work, operationId, sessionId };
}

export function uncertainDiscussionModelGate(stage: PhysicalStage) {
  const state = preparePhysicalDiscussionModel(stage), { model, work, operationId } = state;
  assert(model.send({ type: 'USER_INPUT', text: '新目标', goal: { ...model.context.goal, text: '新目标' } }).ok);
  const usage = structuredClone(model.context.usage);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  const current = model.context.intents.find(item => item.id === work.id)!;
  assert.equal(current.status, 'uncertain', 'Unknown external effects must keep their member occupied');
  assert.equal(current.localOperations!.find(op => op.id === operationId)!.status, 'uncertain');
  assert.equal(model.pending('owner').length, 0); assert.equal(model.pending('discussionSummary').length, 0);
  assert.deepEqual(model.context.usage, usage);
}

export function reconciledDiscussionModelGate() {
  const state = preparePhysicalDiscussionModel('已启动'), { model, work, operationId, sessionId } = state;
  assert(model.send({ type: 'EXHAUSTED', reason: '任务结束，保留尚未核对效果' }).ok);
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  const receipt = { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: '已核对的原始结果' } };
  assert(model.send({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId, sessionId,
    resolution: 'receipt', result: receipt, detail: '宿主已核对效果' }).ok);
  const current = model.context.intents.find(item => item.id === work.id)!;
  assert(['done', 'cancelled'].includes(current.status), 'A settled abandoned round cannot requeue its model work');
  assert.deepEqual(current.localOperations![0]!.result, receipt);
  assert.equal(model.context.discussion!.status, 'cancelled');
  assert.equal(model.pending('discussionSummary').length, 0);
}

export function removedDiscussionMemberModelGate() {
  const state = prepareDiscussionRecoveryModel('并行分片', '修改目标'), { model } = state;
  const config = structuredClone(model.context.config); config.bots = config.bots.filter(bot => bot.id !== 'B');
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert(model.send({ type: 'RECOVER', config }).ok, 'An obsolete safe member must not block current recovery');
  assert(!model.context.reason.includes('unavailable'));
  assert(model.context.intents.filter(work => state.works.some(old => old.id === work.id)).every(work => ['done', 'cancelled'].includes(work.status)));
  assert.equal(model.pending('owner').length, 1);
  assert.equal(model.context.config.bots.some(bot => bot.id === 'B'), false);
}
