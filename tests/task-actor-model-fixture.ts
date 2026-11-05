import assert from 'node:assert/strict';
import { initialTask, stepTask, persistTask, restoreTask, startTaskExecution, executionState, type TaskSnapshot } from '../src/task.machine.js';
import { localModelInput, LocalModel } from './local-model-fixture.js';
import { legacyTaskContract, businessSnapshot } from './task-model-contract.js';
import type { Intent, Phase, TaskEvent } from '../src/types.js';

export const workNames = ['负责人', '协助', '协调', '检查', '输入解析', '讨论汇总', '工具', '取消'];
export class ActorModel {
  snapshot: TaskSnapshot;
  sequence = 0;
  workId = '';
  constructor(readonly name = '负责人') {
    const phase: Record<string, Phase> = { 协助: 'waitingAssistance', 协调: 'coordinating', 输入解析: 'interpreting' };
    this.snapshot = phase[name] ? restoreTask(structuredClone(legacyTaskContract.seeds[phase[name]!])) : initialTask(localModelInput());
    if (name === '检查') {
      const owner = this.claim();
      assert(this.send({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt, text: '候选报告', artifactIds: [] }).ok);
    }
    if (name === '工具') this.send({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} });
    if (name === '取消') { this.claim(); this.send({ type: 'STOP' }); }
    if (name === '讨论汇总') {
      const trace = legacyTaskContract.traces.find(trace => trace.name === '后台讨论')!;
      this.snapshot = initialTask(structuredClone(trace.input));
      for (const event of trace.events) { this.snapshot = stepTask(this.snapshot, structuredClone(event)); if (this.c.intents.some(work => work.status === 'pending' && work.kind === 'discussionSummary')) break; }
    }
    const kinds: Record<string, Intent['kind']> = { 负责人: 'owner', 协助: 'assistance', 协调: 'facilitator', 检查: 'check', 输入解析: 'interpretation', 讨论汇总: 'discussionSummary', 工具: 'tool', 取消: 'cancel' };
    this.workId = this.c.intents.find(work => work.kind === kinds[name] && work.status === 'pending')!.id;
  }
  get c() { return this.snapshot.context; }
  get work() { return this.c.intents.find(work => work.id === this.workId)!; }
  send(body: Record<string, unknown>) {
    this.snapshot = stepTask(this.snapshot, { id: `actor-model:${++this.sequence}`, at: 20, ...body } as TaskEvent);
    this.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(this.snapshot))));
    return this.c.reply;
  }
  claim(id = this.workId || this.c.intents[0]!.id) { this.workId = id; assert(this.send({ type: 'CLAIM', intentId: id }).ok); return this.work; }
  start(attempt = this.work.attempt) {
    const result = startTaskExecution(this.snapshot, this.workId, attempt, 20);
    this.snapshot = result.snapshot; return result.allowed;
  }
  stage(work = this.work) { return executionState(this.snapshot, work.id, work.attempt); }
  assertCreated() {
    assert.equal(this.stage(), 'authorized'); const before = structuredClone(this.c.usage);
    assert(this.start()); assert.equal(this.stage(), 'running'); assert.deepEqual(this.c.usage, before);
    const saved = persistTask(this.snapshot); assert(!this.start()); assert.deepEqual(persistTask(this.snapshot), saved);
  }
}
export function prepareConcurrentActors() {
  const m = new ActorModel(); m.c.config.bots.push({ id: 'C', name: 'C', instructions: '', tools: ['read'] });
  const owner = m.claim(); assert(m.start());
  assert(m.send({ type: 'USER_INPUT', text: '其他成员讨论', reviewTargets: ['B', 'C'] }).ok);
  const plan = m.c.intents.find(work => work.discussionId && work.status === 'pending')!;
  m.claim(plan.id); assert(m.start());
  assert(m.send({ type: 'DISCUSSION_PLAN', workId: plan.id, fence: plan, discussionId: plan.discussionId,
    decision: { action: 'review', question: '核查依据', expected: '证据', reason: '用户邀请' } }).ok);
  const members = m.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'pending'); assert.equal(members.length, 2);
  return () => {
  for (const work of members) { m.claim(work.id); assert(m.start()); }
  assert.equal(executionState(m.snapshot, owner.id, 1), 'running');
  assert.equal(Object.values(m.snapshot.children).filter(child => child?.getSnapshot().value === 'running').length, 3);
  for (const work of members) {
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: work.id, fence: work, discussionId: work.discussionId, status: 'success', text: '独立意见：' + work.target }).ok);
    assert.equal(executionState(m.snapshot, work.id, 1), 'settled');
    assert.equal(executionState(m.snapshot, owner.id, 1), 'running');
  }
  const summary = m.c.intents.find(work => work.kind === 'discussionSummary' && work.status === 'pending')!; m.claim(summary.id); assert(m.start());
  const result = { type: 'DISCUSSION_RESULT', workId: summary.id, fence: summary, discussionId: summary.discussionId, status: 'success', text: '讨论汇总' };
  assert(m.send(result).ok); assert.equal(m.c.discussion!.status, 'ready');
  assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '初稿', artifactIds: [] }).ok);
  assert.equal(m.c.discussion!.status, 'delivered');
  const count = m.c.intents.filter(work => work.kind === 'owner').length;
  assert(!m.send(result).ok); assert.equal(m.c.intents.filter(work => work.kind === 'owner').length, count);
  return m;
  };
}
export const concurrentActors = () => prepareConcurrentActors()();
export function prepareStopActor(timing: string) {
  if (timing === '外部效果未知') {
    const local = new LocalModel(); local.snapshot = startTaskExecution(local.snapshot, local.work.id, 1, 1).snapshot;
    assert(local.request().ok); assert(local.claim().ok); assert(local.started().ok); assert(local.result({ effectsKnown: false }).ok);
    assert.equal(executionState(local.snapshot, local.work.id, 1), 'uncertain');
    return () => {
    assert(local.send({ type: 'STOP' }).ok);
    assert.equal(local.send({ type: 'SETTLE', intentId: local.work.id }).code, 'LOCAL_OPERATION_PENDING');
    assert.equal(executionState(local.snapshot, local.work.id, 1), 'uncertain');
    assert(!startTaskExecution(local.snapshot, local.work.id, 1, 20).allowed);
    };
  }
  const m = new ActorModel(); const work = m.claim();
  if (timing === '已提交启动许可') assert(m.start());
  return () => {
  assert(m.send({ type: 'STOP' }).ok);
  assert.equal(m.stage(), timing === '领取后尚未启动' ? 'cancelled' : 'cancelling');
  assert(!m.start()); assert(m.send({ type: 'SETTLE', intentId: work.id }).ok);
  assert.equal(m.c.outcome, 'stopped');
  const count = m.c.intents.filter(work => work.kind === 'owner').length;
  assert(!m.send({ type: 'DELIVER', text: '迟到', artifactIds: [], workId: work.id, fence: work }).ok);
  assert.equal(m.c.intents.filter(work => work.kind === 'owner').length, count);
  };
}
export const stopActor = (timing: string) => prepareStopActor(timing)();
export function prepareActorRecovery(kind: string) {
  const m = new ActorModel(kind === '非幂等请求执行中' ? '工具' : '负责人');
  if (kind === '非幂等请求执行中') m.work.replay = 'unsafe';
  const old = structuredClone(m.claim());
  if (kind !== '未启动的执行') assert(m.start());
  const saved = kind === '没有子 actor 的旧快照' ? businessSnapshot(m.snapshot) : persistTask(m.snapshot);
  const before = structuredClone(m.c.usage), goal = structuredClone(m.c.goal);
  return () => {
  m.snapshot = restoreTask(JSON.parse(JSON.stringify(saved))); assert.deepEqual(m.c.usage, before); assert.deepEqual(m.c.goal, goal);
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  assert(!m.start(old.attempt));
  if (kind === '非幂等请求执行中') {
    assert.equal(m.work.status, 'uncertain'); assert.equal(m.stage(), 'uncertain');
    assert(m.send({ type: 'RECONCILE', intentId: old.id, resolution: 'notExecuted', detail: '可信核对未执行' }).ok);
    assert(m.send({ type: 'CONTINUE' }).ok); m.workId = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!.id;
  } else {
    assert.equal(m.work.status, 'pending');
    if (kind !== '没有子 actor 的旧快照') assert.equal(m.stage(), 'interrupted');
  }
  m.claim(); assert(m.start()); assert.equal(m.stage(), 'running'); assert.equal(executionState(m.snapshot, old.id, old.attempt) === 'running', false);
  return m;
  };
}
export const recoverActor = (kind: string) => prepareActorRecovery(kind)();
export function prepareDeniedActor(problem: string) {
  const m = new ActorModel(); if (problem !== '尚未领取') m.claim();
  if (problem === '重复启动') assert(m.start());
  if (problem === '旧尝试') { m.send({ type: 'WORK_FAILED', intentId: m.workId, reason: '暂时故障', transient: true }); m.claim(); }
  if (problem === '旧目标版本') m.send({ type: 'USER_INPUT', text: '新目标', goal: { ...m.c.goal, text: '新目标' } });
  if (problem === '已停止') m.send({ type: 'STOP' });
  if (problem === '任务已结束') m.send({ type: 'EXHAUSTED', reason: 'Execution budget exhausted' });
  if (problem === '恢复不兼容') m.send({ type: 'RECOVER', config: { ...m.c.config, version: 'changed' } });
  return () => {
  const before = structuredClone(m.c.usage); assert(!m.start(problem === '旧尝试' ? 1 : m.work.attempt)); assert.deepEqual(m.c.usage, before);
  };
}
export const deniedActor = (problem: string) => prepareDeniedActor(problem)();

export function prepareStaleAttemptMessage(kind = '负责人') {
  const m = new ActorModel(kind); const first = structuredClone(m.claim()); assert(m.start());
  if (kind === '检查') assert(m.send({ type: 'CONSUME', intentId: first.id, fence: first, attempt: first.attempt }).ok);
  if (kind === '讨论汇总') assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  else assert(m.send({ type: 'WORK_FAILED', intentId: first.id, attempt: first.attempt, reason: '暂时故障', transient: true }).ok);
  const next = structuredClone(m.claim()); assert(m.start()); assert.equal(next.attempt, first.attempt + 1);
  if (kind === '检查') assert(m.send({ type: 'CONSUME', intentId: next.id, fence: next, attempt: next.attempt }).ok);
  const before = structuredClone(m.c.usage), phase = m.snapshot.value, analyses = structuredClone(m.c.inputAnalyses);
  return (type: string) => {
    const body: Record<string, unknown> = { type, attempt: first.attempt };
    const addressed = { workId: first.id, fence: first };
    if (type === 'DELIVER') Object.assign(body, addressed, { text: '旧结果', artifactIds: [] });
    else if (type === 'INTERPRETATION_RESULT') {
      const original = legacyTaskContract.traces.find(trace => trace.name === '输入解析')!.events.find(event => event.type === 'INTERPRETATION_RESULT')!;
      assert(original.type === 'INTERPRETATION_RESULT');
      Object.assign(body, addressed, { inputId: m.c.inputAnalyses!.find(input => input.workId === first.id)!.id, spec: original.spec });
    } else if (type === 'COORDINATE') Object.assign(body, addressed, { decision: m.c.review?.status === 'pending'
      ? { action: 'review', question: '核查依据', expected: '事实', reason: '受控评审' } : { action: 'continue', reason: '受控判断' } });
    else if (type === 'RECORD_RESULT') Object.assign(body, addressed, { requestId: first.payload.requestId, resultId: 'attempt-result', status: 'success', answer: '核查结果' });
    else if (type === 'CHECK_RESULT') {
      const candidate = m.c.candidate!;
      Object.assign(body, addressed, { resultId: 'check-result', candidateRevision: candidate.revision,
        criteriaResults: candidate.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) });
    }
    else if (type === 'DISCUSSION_RESULT') Object.assign(body, addressed, { discussionId: first.discussionId, status: 'success', text: '受控讨论结果' });
    else Object.assign(body, { intentId: first.id, reason: '旧错误', transient: false, issue: 'invalid_json' });
    assert.equal(m.send(body).code, 'STALE_ATTEMPT'); assert.equal(m.stage(), 'running'); assert.equal(m.snapshot.value, phase);
    assert.equal(m.work.status, 'inflight'); assert.deepEqual(m.c.usage, before); assert.deepEqual(m.c.inputAnalyses, analyses);
    const completion: Record<string, unknown> = ['DELIVER', 'INTERPRETATION_RESULT', 'COORDINATE', 'RECORD_RESULT', 'CHECK_RESULT', 'DISCUSSION_RESULT'].includes(type)
      ? { ...body, attempt: next.attempt }
      : { type: 'DELIVER', workId: next.id, attempt: next.attempt, fence: next, text: '新尝试有效结果', artifactIds: [] };
    const completed = m.send(completion); assert(completed.ok, completed.code); assert.equal(m.stage(), 'settled');
  };
}
export const staleAttemptMessage = (type: string) => prepareStaleAttemptMessage(({ INTERPRETATION_RESULT: '输入解析', COORDINATE: '协调', RECORD_RESULT: '协助', CHECK_RESULT: '检查', DISCUSSION_RESULT: '讨论汇总' } as Record<string, string>)[type] ?? '负责人')(type);

export function oldExecutionCleanup() {
  const m = new ActorModel(), old = structuredClone(m.claim()); assert(m.start());
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); const current = structuredClone(m.claim()); assert(m.start());
  assert.equal(executionState(m.snapshot, old.id, old.attempt), 'interrupted');
  assert.equal(m.send({ type: 'DELIVER', workId: old.id, attempt: old.attempt, fence: old, text: '旧输出', artifactIds: [] }).code, 'STALE_ATTEMPT');
  assert.equal(m.stage(), 'running'); assert(m.send({ type: 'STOP' }).ok); assert.equal(m.stage(), 'cancelling');
  assert(m.send({ type: 'SETTLE', intentId: current.id, attempt: current.attempt }).ok); assert.equal(m.stage(), 'settled');
  assert.equal(m.c.outcome, 'stopped'); assert.equal(m.c.candidate, null);
}
