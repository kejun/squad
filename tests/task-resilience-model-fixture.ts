import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, executionState } from '../src/task.machine.js';
import { processingWindow, effectiveWork, taskHumanGate } from '../src/task/resilience.js';
import { localModelInput } from './local-model-fixture.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { publicationIds } from '../src/task/delivery.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import type { Intent, Phase, TaskEvent } from '../src/types.js';

export class ResilienceModel {
  snapshot; seq = 0; at = 1;
  constructor(configure: (input: ReturnType<typeof localModelInput>) => void = () => {}) {
    const input = localModelInput(); input.config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2, cancelGraceMs: 5, allowMissingContent: true };
    configure(input); this.snapshot = initialTask(input);
  }
  get c() { return this.snapshot.context; }
  get phase() { return taskPhase(this.snapshot); }
  send(body: Record<string, unknown>) {
    this.snapshot = restoreTask(structuredClone(persistTask(stepTask(this.snapshot, { id: `resilience:${++this.seq}`, at: this.at, ...body } as TaskEvent))));
    return this.c.reply;
  }
  pending(kind?: Intent['kind']) { return this.c.intents.filter(w => w.status === 'pending' && (!kind || w.kind === kind)); }
  claim(kind: Intent['kind'] = 'owner') {
    const pending = this.pending(kind)[0]!; assert(pending, `missing ${kind}`); assert(this.send({ type: 'CLAIM', intentId: pending.id }).ok);
    return structuredClone(this.c.intents.find(w => w.id === pending.id)!);
  }
  artifact(id = 'current-artifact') { assert(this.send({ type: 'ARTIFACT', artifact: { id, name: `${id}.md`, content: '已保存但未核验的业务材料' } }).ok); }
  supervise(at = this.at) { this.at = at; return this.send({ type: 'SUPERVISE', trigger: 'timer' }); }
  endWindow(at = processingWindow(this.c).hardDeadline) {
    assert(this.supervise(at).ok);
    const gate = taskHumanGate(this.c); assert.equal(gate?.cause, 'windowExpired');
    assert(this.send({ type: 'HUMAN_GATE_DECISION', gateId: gate!.id, decision: 'skip', text: '明确结束到期窗口并保留已有成果' }).ok);
    return this.c.reply;
  }
  waiting() { const work = this.claim(); assert(this.send({ type: 'WAIT_USER', workId: work.id, fence: work, question: '请选择方案' }).ok); return taskHumanGate(this.c)!; }
  unknown() {
    const work = this.claim();
    assert(this.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'unknown-op', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
      action: { type: 'runCli', executable: 'node', args: ['effect.js'] }, parentAttempt: work.attempt, fence: work, messages: [], workspaceId: 'resource' }).ok);
    assert(this.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'unknown-op', parentAttempt: work.attempt, fence: work, sessionId: 'unknown-session', leaseAvailable: true }).ok);
    assert(this.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session' }).ok);
    assert(this.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session', settled: true, effectsKnown: false, result: { ok: false, code: 'timeout', data: {} } }).ok);
    return work;
  }
}
export function stageModel(phase: Phase): ResilienceModel {
  const m = new ResilienceModel(input => { if (phase === 'waitingHuman') input.config.limits.retries = 0; });
  if (phase === 'interpreting') {
    const c = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2 }; });
    m.snapshot = c.snapshot; return m;
  }
  if (phase === 'running') return m;
  if (phase === 'ended') { assert(m.send({ type: 'EXHAUSTED', reason: '无额度' }).ok); return m; }
  const owner = m.claim();
  if (phase === 'coordinating') { assert(m.send({ type: 'BLOCKED', workId: owner.id, fence: owner, reason: '需要改进' }).ok); const w = m.claim('facilitator'); assert(m.send({ type: 'SETTLE', intentId: w.id }).ok); }
  if (phase === 'waitingAssistance') { assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'help', caller: 'A', target: 'B', question: '核查', expected: '依据' }).ok); const w = m.claim('assistance'); assert(m.send({ type: 'SETTLE', intentId: w.id }).ok); }
  if (phase === 'waitingHuman') assert(m.send({ type: 'WORK_FAILED', intentId: owner.id, reason: 'technical failure', transient: false }).ok);
  if (phase === 'checking') assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '待核验草稿', artifactIds: [] }).ok);
  if (phase === 'stopping') assert(m.send({ type: 'STOP' }).ok);
  assert.equal(m.phase, phase); return m;
}
export function resiliencePhaseGate() {
  return (['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking', 'stopping', 'ended'] as Phase[]).map(phase => {
    const m = stageModel(phase); assert(m.supervise(101).ok);
    const terminal = ['stopping', 'ended'].includes(phase);
    assert.equal(m.phase, terminal ? 'ended' : 'waitingHuman', `${phase} must retain a visible supervision exit`);
    assert.equal(m.c.outcome !== null, terminal);
    const frozen = structuredClone(m.c.resilience!.frozen), gateId = taskHumanGate(m.c)?.id;
    if (!terminal) { assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired'); assert.equal(processingWindow(m.c).failure?.code, 'WINDOW_EXPIRED'); }
    assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert(m.supervise(1000).ok);
    assert.deepEqual(m.c.resilience!.frozen, frozen); assert.equal(taskHumanGate(m.c)?.id, gateId); return { phase, outcome: m.c.outcome };
  });
}
export function resilienceWindowGate() {
  const m = new ResilienceModel(), original = structuredClone(processingWindow(m.c)); m.artifact();
  assert(m.send({ type: 'BOARD_WRITE', author: 'user', entryId: 'new-evidence', text: '用户提供材料', kind: 'evidence', sources: ['M'] }).ok);
  assert(m.send({ type: 'PROGRESS', detail: '保存材料', refs: ['new-evidence'] }).ok);
  assert(m.send({ type: 'ACTIVITY', text: '仍在处理' }).ok); assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  assert(m.send({ type: 'USER_INPUT', text: '增加一段结论' }).ok);
  assert.deepEqual(processingWindow(m.c), original); m.supervise(101);
  assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired');
  assert.equal(processingWindow(m.c).hardDeadline, original.hardDeadline); assert.equal(processingWindow(m.c).repairUsed, original.repairUsed);
  assert.equal(m.c.resilience!.frozen, undefined); return m;
}
export function resilienceHumanGate(newWindow = false) {
  const m = new ResilienceModel(); m.artifact(); const gate = m.waiting();
  m.supervise(101); assert.equal(m.phase, 'waitingHuman'); assert.equal(taskHumanGate(m.c)?.id, gate.id); assert.equal(m.c.resilience!.nextSupervisionAt, null);
  assert.equal(m.send({ type: 'HUMAN_GATE_DECISION', gateId: 'stale', decision: 'reply', text: '甲' }).code, 'HUMAN_GATE_NOT_FOUND');
  const reply = { type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: newWindow ? 'newWindow' : 'reply', text: '选择甲', ...(newWindow ? { newWindowMs: 50 } : {}) };
  assert(m.send(reply).ok);
  if (newWindow) { assert.equal(processingWindow(m.c).hardDeadline, 151); assert.equal(m.phase, 'running'); assert(effectiveWork(m.c, m.phase, m.at).length > 0); }
  else { assert.equal(m.c.outcome, null); assert.equal(m.phase, 'waitingHuman'); assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired'); assert.equal(processingWindow(m.c).hardDeadline, 100); }
  return m;
}
export function resilienceCleanupGate() {
  const m = new ResilienceModel(); m.artifact(); const work = m.unknown(); assert(!taskHumanGate(m.c));
  m.endWindow(101); assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, 'partial'); assert.equal(m.c.resilience!.cleanup[0]!.state, 'pending');
  assert(m.c.resilience!.gates.some(g => g.scope === 'cleanup' && g.status === 'open')); const frozen = structuredClone(m.c.resilience!.frozen);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session', settled: true, effectsKnown: true, result: { ok: true, code: 'succeeded', data: { stdout: 'receipt' } } }).ok);
  assert.equal(m.c.resilience!.cleanup[0]!.state, 'settled'); assert.equal(m.c.intents.find(w => w.id === work.id)!.status, 'done');
  assert.deepEqual(m.c.resilience!.frozen, frozen); assert.equal(m.phase, 'ended'); return m;
}
export function resilienceStopGate() {
  for (const order of ['stop-recover-result', 'stop-result-recover', 'recover-stop-result']) {
    const m = new ResilienceModel(), work = m.unknown();
    if (order.startsWith('recover')) assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert(m.send({ type: 'STOP' }).ok);
    if (order === 'stop-recover-result') assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session', settled: true, effectsKnown: true, result: { ok: false, code: 'known-failure', data: {} } }).ok);
    if (order === 'stop-result-recover') assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, 'stopped'); assert.equal(m.c.stopped, true);
  }
}
export function resilienceReceiptContinuationGate() {
  const m = new ResilienceModel(), work = m.unknown();
  assert(m.supervise(2).ok); assert.equal(m.phase, 'coordinating');
  const facilitator = m.claim('facilitator'); m.at = 3;
  assert(m.send({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session', resolution: 'receipt',
    result: { ok: false, code: 'CLI_EFFECTS_RECONCILED', data: { operatorConfirmed: true } }, detail: '宿主可信核对原效果已结算' }).ok);
  const original = structuredClone(m.c.intents.find(item => item.id === work.id)!);
  assert.equal(original.status, 'pending'); assert(original.localCheckpoint!.messages.some(message => message.content.includes('CLI_EFFECTS_RECONCILED')));
  const fixedWindow = structuredClone(processingWindow(m.c));
  m.at = 4;
  assert(m.send({ type: 'COORDINATE', workId: facilitator.id, fence: facilitator, decision: { action: 'continue', reason: '依据原可信回执继续交付' } }).ok);
  assert.equal(m.phase, 'running'); assert.equal(m.pending('owner').length, 1); assert.equal(m.pending('owner')[0]!.id, work.id);
  const resumed = m.claim(); assert.equal(resumed.id, work.id); assert.equal(resumed.attempt, original.attempt + 1);
  assert.deepEqual(resumed.localOperations, original.localOperations); assert.deepEqual(resumed.localCheckpoint, original.localCheckpoint);
  assert.deepEqual(processingWindow(m.c), fixedWindow); assert.equal(resumed.deadline, fixedWindow.repairDeadline);
  assert.equal(resumed.localOperations![0]!.parentAttempt, work.attempt); assert.equal(resumed.localOperations![0]!.finishedAt, 3);
  assert.equal(m.c.intents.filter(item => item.kind === 'owner').length, 1); return m;
}
export function resilienceReviewReplyGate() {
  const m = new ResilienceModel(); m.artifact('review-material'); const gate = m.waiting(), deadline = processingWindow(m.c).hardDeadline;
  assert(m.send({ type: 'USER_INPUT', text: '请B评审已有方案', reviewTargets: ['B'] }).ok);
  assert.equal(m.c.resilience!.gates.find(item => item.id === gate.id)!.status, 'answered');
  assert.equal(m.phase, 'coordinating'); assert.equal(m.pending('facilitator').length, 1);
  assert(JSON.stringify(m.pending('facilitator')[0]!.payload).includes('review-material')); assert.equal(processingWindow(m.c).hardDeadline, deadline); return m;
}
export function resilienceReviewRetryGate() {
  const m = new ResilienceModel(input => input.config.bots.push({ ...input.config.bots[1]!, id: 'builder-1' }));
  assert(m.send({ type: 'USER_INPUT', text: '请B和builder-1评审', reviewTargets: ['B', 'builder-1'] }).ok);
  const facilitator = m.claim('facilitator'); assert(m.send({ type: 'COORDINATE', workId: facilitator.id, fence: facilitator,
    decision: { action: 'review', question: '核查恢复能力', expected: '依据', reason: '用户邀请' } }).ok);
  const failed = m.claim('assistance'); assert(m.send({ type: 'WORK_FAILED', intentId: failed.id, reason: 'B中断', transient: false }).ok);
  const other = m.claim('assistance'), requestId = String(other.payload.requestId);
  assert(m.send({ type: 'RECORD_RESULT', requestId, resultId: 'other-review', status: 'success', answer: '其他成员的意见', workId: other.id, fence: other }).ok);
  assert(m.send({ type: 'HELP_RESULT', requestId, resultId: 'other-review', status: 'success', answer: '其他成员的意见' }).ok);
  const owner = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '评审暂未完成', artifactIds: [] }).ok);
  const check = m.claim('check'), candidate = m.c.candidate!; assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check }).ok);
  assert(m.send({ type: 'WORK_FAILED', intentId: check.id, fence: check, attempt: check.attempt,
    transient: false, reason: '旧检查执行中断，已有材料保留为未核验结果' }).ok);
  assert.equal(m.c.outcome, 'partial'); const frozen = structuredClone(m.c.resilience!.frozen), deadline = processingWindow(m.c).hardDeadline;
  assert(m.send({ type: 'RETRY_ASSISTANCE', requestId: String(failed.payload.requestId), text: '明确重试B', config: m.c.config }).ok);
  assert.equal(m.c.resilience!.frozen, undefined); assert.deepEqual(m.c.resilience!.frozenHistory!.at(-1), frozen);
  const retry = m.claim('assistance'), retryId = String(retry.payload.requestId);
  assert(m.send({ type: 'RECORD_RESULT', requestId: retryId, resultId: 'retried-review', status: 'success', answer: 'B本次意见', workId: retry.id, fence: retry }).ok);
  assert(m.send({ type: 'HELP_RESULT', requestId: retryId, resultId: 'retried-review', status: 'success', answer: 'B本次意见' }).ok);
  assert.equal(m.phase, 'running'); assert.equal(m.pending('owner').length, 1); assert(JSON.stringify(m.pending('owner')[0]!.payload).includes('其他成员的意见'));
  assert.equal(processingWindow(m.c).hardDeadline, deadline); assert.deepEqual(m.c.resilience!.frozenHistory!.at(-1), frozen); return m;
}
export function resilienceContinueGate(stage: string) {
  const m = new ResilienceModel(), owner = m.claim();
  assert(m.send({ type: 'USER_INPUT', text: '请B讨论', reviewTargets: ['B'] }).ok);
  if (stage !== 'planning') {
    const p = m.claim('facilitator'); assert(m.send({ type: 'DISCUSSION_PLAN', workId: p.id, fence: p, discussionId: p.discussionId,
      decision: { action: 'review', question: '核查', expected: '依据', reason: '用户邀请' } }).ok);
  }
  if (stage === 'summarizing' || stage === 'ready') {
    const p = m.claim('assistance'); assert(m.send({ type: 'DISCUSSION_RESULT', workId: p.id, fence: p, discussionId: p.discussionId, status: 'success', text: '成员意见' }).ok);
  }
  if (stage === 'ready') { const p = m.claim('discussionSummary'); assert(m.send({ type: 'DISCUSSION_RESULT', workId: p.id, fence: p, discussionId: p.discussionId, status: 'success', text: '汇总' }).ok); }
  assert(m.send({ type: 'WAIT_USER', workId: owner.id, fence: owner, question: '请选择' }).ok);
  assert(m.send({ type: 'CONTINUE' }).ok); assert.equal(m.c.epoch, 2); assert.equal(m.c.discussion!.status, 'cancelled');
  assert(effectiveWork(m.c, m.phase, m.at).some(w => w.kind === 'owner')); assert.equal(m.c.outcome, null); return m;
}
export function resilienceSavedResultGate() {
  const m = new ResilienceModel(), owner = m.claim();
  assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'saved-help', caller: 'A', target: 'B', question: '核查', expected: '依据' }).ok);
  const help = m.claim('assistance'); assert(m.send({ type: 'RECORD_RESULT', workId: help.id, fence: help, requestId: 'saved-help', resultId: 'saved-result', status: 'success', answer: '已保存的协助结果' }).ok);
  assert(m.send({ type: 'EXHAUSTED', reason: '执行中断' }).ok); assert.equal(m.phase, 'ended');
  const usage = structuredClone(m.c.usage); assert(m.send({ type: 'RETRY_ASSISTANCE', requestId: 'saved-help', text: '明确继续已有结果', config: m.c.config }).ok);
  assert.equal(m.phase, 'running'); assert.equal(m.c.outcome, null); assert.equal(m.c.results[0]!.consumed, true);
  assert.equal(m.pending('owner').length, 1); assert.deepEqual(m.c.usage, usage); assert(effectiveWork(m.c, m.phase, m.at).length > 0);
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert.equal(m.pending('owner').length, 1); return m;
}
export function resilienceDeadlineGate(tickFirst: boolean) {
  const m = new ResilienceModel(), owner = m.claim();
  assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'deadline-help', caller: 'A', target: 'B', question: '核查', expected: '依据' }).ok);
  const help = m.claim('assistance'); m.at = help.deadline! + 1;
  if (tickFirst) assert(m.send({ type: 'HELP_RESULT', requestId: 'deadline-help', resultId: 'timeout-result', status: 'timeout', answer: '协助已超时' }).ok);
  const saved = m.send({ type: 'RECORD_RESULT', workId: help.id, fence: help, requestId: 'deadline-help', resultId: 'late-result', status: 'success', answer: '迟到的成功声明' });
  if (!tickFirst) {
    assert(saved.ok); assert.equal(m.c.results[0]!.status, 'timeout');
    const savedResult = m.c.results[0]!;
    assert(m.send({ type: 'HELP_RESULT', requestId: savedResult.requestId, resultId: savedResult.resultId, status: savedResult.status, answer: savedResult.answer, fence: savedResult }).ok);
  } else assert.equal(saved.ok, false);
  assert.equal(m.c.assists[0]!.status, 'timeout'); assert.equal(m.c.consumedResults.length, 1); assert(m.c.lateResults.length > 0); return m;
}
export function resilienceLegacyGate() {
  const m = new ResilienceModel(), saved = structuredClone(persistTask(m.snapshot)) as { context: ResilienceModel['c'] };
  delete saved.context.resilience; m.snapshot = restoreTask(saved); m.at = 50;
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert.equal(processingWindow(m.c).hardDeadline, 100);
  m.at = 80; assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert.equal(processingWindow(m.c).hardDeadline, 100); return m;
}
export function resilienceResultDeadlineGate() {
  const rows: { role: string; offset: number; tickFirst: boolean; accepted: boolean }[] = [];
  for (const role of ['owner', 'facilitator', 'check'] as const) for (const offset of [-1, 0, 1]) for (const tickFirst of [false, true]) {
    const m = new ResilienceModel(input => { input.config.limits.workTimeoutMs = 50; });
    let work = m.claim();
    if (role === 'facilitator') { assert(m.send({ type: 'BLOCKED', workId: work.id, fence: work, reason: '选择后继' }).ok); work = m.claim('facilitator'); }
    if (role === 'check') {
      assert(m.send({ type: 'DELIVER', workId: work.id, fence: work, text: '已有草稿', artifactIds: [] }).ok); work = m.claim('check');
      assert(m.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
    }
    m.at = work.deadline! + offset;
    if (tickFirst) m.supervise();
    const event = role === 'owner' ? { type: 'DELIVER', text: '返回的最终草稿', artifactIds: [] }
      : role === 'facilitator' ? { type: 'COORDINATE', decision: { action: 'continue', reason: '下一步' } }
        : { type: 'CHECK_RESULT', resultId: 'deadline-check', candidateRevision: (work.payload.candidate as { revision: string }).revision,
          criteriaResults: fixtureCheck(work.payload.candidate).criteriaResults };
    const reply = m.send({ ...event, workId: work.id, attempt: work.attempt, fence: work });
    assert.equal(reply.ok, offset < 0, `${role}/${offset}/${tickFirst}: business result expiry cannot depend on timer order`);
    if (!tickFirst) m.supervise();
    if (offset >= 0) { assert.notEqual(m.c.outcome, 'complete'); assert(m.c.lateResults.some(result => result.workId === work.id)); }
    rows.push({ role, offset, tickFirst, accepted: reply.ok });
  }
  return rows;
}
export function resilienceRecoveredCustodyGate() {
  const rows: { stage: string; logical: string; settled: string }[] = [];
  for (const stage of ['claimed', 'running', 'cancelling']) for (const logical of ['stopped', 'partial']) {
    const m = new ResilienceModel(); m.artifact(); const work = m.claim();
    assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'custody-op', namespace: 'c'.repeat(64), requestHash: 'b'.repeat(64),
      action: { type: 'runCli', executable: 'node', args: ['effect.js'] }, parentAttempt: work.attempt, fence: work, messages: [], workspaceId: 'custody-resource' }).ok);
    assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'custody-op', parentAttempt: work.attempt, fence: work, sessionId: 'custody-session', leaseAvailable: true }).ok);
    if (stage !== 'claimed') assert(m.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: 'custody-op', sessionId: 'custody-session' }).ok);
    assert(m.send(logical === 'stopped' ? { type: 'STOP' } : { type: 'EXHAUSTED', reason: '结束自动处理' }).ok);
    const frozen = structuredClone(m.c.resilience!.frozen); assert.equal(m.phase, 'ended');
    assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    const restored = m.c.intents.find(w => w.id === work.id)!.localOperations![0]!;
    assert.equal(restored.status, 'uncertain'); assert.equal(restored.sessionId, 'custody-session'); assert.equal(restored.workspaceId, 'custody-resource');
    assert(m.send({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: 'custody-op', sessionId: 'custody-session', resolution: 'notStarted', detail: '可信宿主证明没有启动进程' }).ok);
    assert.equal(m.c.resilience!.cleanup[0]!.state, 'settled'); assert.equal(m.c.intents.find(w => w.id === work.id)!.localOperations![0]!.status, 'cancelled');
    assert.deepEqual(m.c.resilience!.frozen, frozen); assert.equal(m.phase, 'ended'); assert.equal(m.pending('owner').length, 0);
    rows.push({ stage, logical, settled: m.c.resilience!.cleanup[0]!.state });
  }
  return rows;
}
export function resilienceDirectResponseGate(kind: 'input' | 'retry', expired = false) {
  let m = new ResilienceModel();
  if (kind === 'input') {
    const seed = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2 }; });
    m.snapshot = seed.snapshot; const work = m.claim('interpretation');
    assert(m.send({ type: 'WORK_FAILED', intentId: work.id, reason: 'Model not configured', transient: false, attempt: work.attempt }).ok);
  } else {
    const owner = m.claim(); assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'blocked-help', caller: 'A', target: 'B', question: '核对材料', expected: '依据' }).ok);
    const help = m.claim('assistance'); assert(m.send({ type: 'WORK_FAILED', intentId: help.id, attempt: help.attempt, reason: '核查中断', transient: false }).ok);
    const owner2 = m.claim(); assert(m.send({ type: 'WAIT_USER', workId: owner2.id, fence: owner2, question: '核查中断，请明确重试B' }).ok);
  }
  const gate = taskHumanGate(m.c)!; assert(gate); assert.equal(m.phase, 'waitingHuman');
  const deadline = processingWindow(m.c).hardDeadline;
  if (expired) m.at = deadline;
  assert(m.send(kind === 'input' ? { type: 'USER_INPUT', text: '方案甲' } : { type: 'RETRY_ASSISTANCE', requestId: 'blocked-help', text: '明确重试B', config: m.c.config }).ok);
  assert.equal(m.c.resilience!.gates.find(g => g.id === gate.id)!.status, 'answered');
  assert.equal(processingWindow(m.c).hardDeadline, deadline);
  if (expired) { assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired'); return m; }
  assert(!taskHumanGate(m.c));
  assert.equal(m.phase, kind === 'input' ? 'interpreting' : 'waitingAssistance');
  assert(effectiveWork(m.c, m.phase, m.at).some(w => w.kind === (kind === 'input' ? 'interpretation' : 'assistance')));
  if (kind === 'retry') {
    const help = m.claim('assistance'), requestId = String(help.payload.requestId);
    assert(m.send({ type: 'RECORD_RESULT', requestId, resultId: 'retried-result', status: 'success', answer: '已核查材料', workId: help.id, attempt: help.attempt, fence: help }).ok);
    assert(m.send({ type: 'HELP_RESULT', requestId, resultId: 'retried-result', status: 'success', answer: '已核查材料' }).ok);
    const owner = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '核查后的交付', artifactIds: [] }).ok);
    const check = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check }).ok);
    const candidate = check.payload.candidate as import('../src/types.js').Candidate;
    assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, candidateRevision: candidate.revision, resultId: 'checked-retry', criteriaResults: fixtureCheck(candidate).criteriaResults }).ok);
    assert.equal(m.c.outcome, 'complete');
  }
  return m;
}
export function resilienceSkippedCompletionGate() {
  const m = new ResilienceModel(); const gate = m.waiting();
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确允许缺少这部分内容' }).ok);
  const owner = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '模型声称全部完成', artifactIds: [] }).ok);
  const check = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check }).ok);
  const candidate = check.payload.candidate as import('../src/types.js').Candidate;
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, candidateRevision: candidate.revision, resultId: 'checked-skipped', criteriaResults: fixtureCheck(candidate).criteriaResults }).ok);
  assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, 'complete'); assert.equal(m.c.resilience!.frozen, undefined);
  assert.equal(m.c.resilience!.skips[0]!.reason, '明确允许缺少这部分内容');
  assert((check.payload.executionNotes as string[]).some(note => note.includes('明确允许缺少这部分内容')));
  assert(m.c.publishedDelivery); return m;
}
/** Actual resource identity is independent of the task workspace and preparation lifetime. */
export function resilienceCleanupResourceGate(prepared: boolean) {
  const m = new ResilienceModel(), work = m.claim();
  const resourceLeases = [{ key: 'workspace:source', mode: 'read', phase: 'prepare' },
    { key: 'workspace:isolated-copy', mode: 'write', phase: 'execute' }, { key: 'service:shared', mode: 'read', phase: 'execute' }];
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'resource-op', namespace: 'c'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['effect.js'] }, parentAttempt: work.attempt, fence: work, messages: [],
    workspaceId: 'workspace:source', conflictKey: 'workspace:isolated-copy', resourceLeases }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'resource-op', parentAttempt: work.attempt, fence: work, sessionId: 'resource-session', leaseAvailable: true }).ok);
  if (prepared) assert(m.send({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: 'resource-op', sessionId: 'resource-session', isolated: true }).ok);
  assert(m.send({ type: 'STOP' }).ok); assert.equal(m.phase, 'ended');
  assert.deepEqual(m.c.resilience!.cleanup[0]!.resourceKeys,
    prepared ? ['workspace:isolated-copy', 'service:shared'] : ['workspace:source', 'workspace:isolated-copy', 'service:shared']);
  assert.deepEqual(m.c.intents.find(item => item.id === work.id)!.localOperations![0]!.resourceLeases, resourceLeases);
  return m;
}
export function resilienceLegacyUnsafeGate(stopped = false) {
  const m = new ResilienceModel(); m.artifact(); const owner = m.claim();
  assert(m.send({ type: 'TOOL', workId: owner.id, fence: owner, tool: 'read', replay: 'unsafe', payload: { effect: 'legacy-provider' } }).ok);
  const tool = m.claim('tool'); assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  if (stopped) assert(m.send({ type: 'STOP' }).ok); else m.endWindow(101);
  assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, stopped ? 'stopped' : 'partial');
  const custody = m.c.resilience!.cleanup.find(item => item.kind === 'legacyWork')!;
  assert(custody); assert.equal(custody.workId, tool.id); assert.equal(custody.operationId, tool.id);
  assert.deepEqual(custody.resourceKeys, ['squad:unconfined-external-effects']); assert.equal(custody.state, 'pending');
  const gate = m.c.resilience!.gates.find(item => item.id === custody.gateId)!;
  assert.equal(gate.scope, 'cleanup'); assert.equal(gate.workId, tool.id); assert.equal(gate.operationId, undefined);
  assert(gate.question.includes('提供方可信核对')); assert(m.c.resilience!.nextSupervisionAt! > m.at);
  const frozen = structuredClone(m.c.resilience!.frozen);
  assert.equal(m.send({ type: 'SETTLE', intentId: tool.id }).code, 'LEGACY_EFFECT_REQUIRES_RECONCILIATION');
  assert.equal(m.send({ type: 'WORK_FAILED', intentId: tool.id, reason: '迟到失败不能证明效果已知', transient: false }).ok, false);
  assert.equal(m.c.intents.find(work => work.id === tool.id)!.status, 'uncertain');
  assert.equal(m.c.resilience!.cleanup[0]!.state, 'pending');
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'reply', text: '我已看到提示' }).ok);
  assert.equal(m.c.resilience!.cleanup[0]!.state, 'pending'); assert.equal(m.c.resilience!.gates.find(item => item.id === gate.id)!.status, 'open');
  assert(m.send({ type: 'RECONCILE', intentId: tool.id, resolution: 'confirmed', detail: '提供方可信核对确认原操作实际效果', fence: tool }).ok);
  assert.equal(m.c.resilience!.cleanup[0]!.state, 'settled'); assert.equal(m.c.resilience!.gates.find(item => item.id === gate.id)!.status, 'answered');
  assert.equal(m.c.resilience!.nextSupervisionAt, null); assert.equal(m.pending('owner').length, 0); assert.deepEqual(m.c.resilience!.frozen, frozen);
  return m;
}
export function resilienceRetryGateBinding(unrelated: boolean) {
  const m = new ResilienceModel(input => {
    input.config.inputAnalysis = { enabled: true };
    input.config.models = { default: 'fixture', services: { fixture: { baseUrl: 'https://example.test/v1', model: 'fixture' } } };
  });
  const owner = m.claim(); assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'auth-help', caller: 'A', target: 'B', question: '核对材料', expected: '依据' }).ok);
  const help = m.claim('assistance'); assert(m.send({ type: 'WORK_FAILED', intentId: help.id, reason: unrelated ? '核查中断' : 'Model not configured', transient: false }).ok);
  if (unrelated) {
    assert(m.send({ type: 'USER_INPUT', text: '必须选择一个方案，请先解释目标取舍' }).ok);
    assert.equal(m.phase, 'interpreting'); const parse = m.claim('interpretation');
    assert(m.send({ type: 'INTERPRETATION_RESULT', workId: parse.id, fence: parse, inputId: (parse.payload.input as { id: string }).id,
      spec: { action: 'supplement', objective: '核对目标', constraints: [], expectedOutputs: ['报告'], acceptanceCriteria: ['可核对'], confidence: 1,
        references: [], clarification: '必需目标仍需选择' } }).ok);
  }
  const gate = taskHumanGate(m.c)!; assert(gate); const deadline = processingWindow(m.c).hardDeadline;
  assert(m.send({ type: 'RETRY_ASSISTANCE', requestId: 'auth-help', text: '明确重试B', config: m.c.config }).ok);
  assert.equal(processingWindow(m.c).hardDeadline, deadline);
  assert.equal(taskHumanGate(m.c)?.id, unrelated ? gate.id : undefined);
  if (unrelated) { const pending = m.pending('assistance')[0]!; assert(pending); assert.equal(m.send({ type: 'CLAIM', intentId: pending.id }).code, 'HUMAN_GATE_REQUIRED'); }
  else { assert.equal(m.c.resilience!.gates.find(item => item.id === gate.id)!.response, '明确重试B'); assert(effectiveWork(m.c, m.phase, m.at).some(item => item.kind === 'assistance')); }
  return m;
}
export function resilienceRequiredFailureGate(role: 'owner' | 'interpretation' | 'assistance' | 'facilitator' | 'check', transient = false, expired = false) {
  const m = new ResilienceModel();
  if (role === 'interpretation') {
    const seed = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2 }; }); m.snapshot = seed.snapshot;
  } else if (role !== 'owner') {
    const owner = m.claim();
    if (role === 'assistance') assert(m.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'permission-help', caller: 'A', target: 'B', question: '核对材料', expected: '依据' }).ok);
    if (role === 'facilitator') assert(m.send({ type: 'BLOCKED', workId: owner.id, fence: owner, reason: '请继续协调' }).ok);
    if (role === 'check') assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '等待独立核验的草稿', artifactIds: [] }).ok);
  }
  const work = m.claim(role); if (role === 'check') assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok);
  const usage = structuredClone(m.c.usage); if (expired) m.at = work.deadline!;
  assert(m.send({ type: 'WORK_FAILED', intentId: work.id, attempt: work.attempt, reason: 'Model HTTP 401', transient }).ok);
  assert.equal(m.c.usage.retries, usage.retries, 'Permission failure cannot become an automatic retry');
  if (expired) { assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired'); m.supervise(101); assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); return m; }
  const gate = taskHumanGate(m.c)!; assert(gate); assert.equal(gate.kind, 'authorization');
  assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null);
  m.supervise(101); assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  assert.equal(m.phase, 'waitingHuman'); assert.equal(taskHumanGate(m.c)?.id, gate.id); assert.equal(m.c.outcome, null);
  return m;
}
export function resilienceNotStartedLifecycleGate(logical: '已请求停止' | '已发布partial' | '已经complete') {
  const m = new ResilienceModel(); let original;
  if (logical === '已经complete') {
    const owner = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '完整业务交付', artifactIds: [] }).ok);
    original = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: original.id, fence: original }).ok);
    const candidate = original.payload.candidate as import('../src/types.js').Candidate;
    assert(m.send({ type: 'CHECK_RESULT', workId: original.id, fence: original, attempt: original.attempt, candidateRevision: candidate.revision,
      resultId: 'completed-before-receipt', criteriaResults: fixtureCheck(candidate).criteriaResults }).ok);
  } else {
    m.artifact(); original = m.claim();
    assert(m.send(logical === '已请求停止' ? { type: 'STOP' } : { type: 'EXHAUSTED', reason: '已有成果先交付缺口' }).ok);
    assert.equal(executionState(m.snapshot, original.id, original.attempt), 'cancelled');
  }
  const before = { outcome: m.c.outcome, frozen: structuredClone(m.c.resilience!.frozen), usage: structuredClone(m.c.usage) };
  const reply = m.send({ type: 'EXECUTION_NOT_STARTED', intentId: original.id, attempt: original.attempt, fence: original, reason: '可信执行许可确认原请求未启动' });
  assert.equal(reply.ok, logical !== '已经complete');
  assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, logical === '已请求停止' ? 'stopped' : logical === '已发布partial' ? 'partial' : 'complete');
  assert.equal(m.pending('owner').length, 0); assert.deepEqual(m.c.usage, before.usage);
  if (logical !== '已请求停止') assert.deepEqual(m.c.resilience!.frozen, before.frozen);
  assert.notEqual(m.c.intents.find(w => w.id === original.id)!.status, 'pending'); return m;
}
export function resilienceRepeatedPartialGate() {
  const m = new ResilienceModel(); m.artifact('old-goal');
  assert(m.send({ type: 'USER_INPUT', text: '当前目标', goal: { text: '当前目标', constraints: [], criteria: ['可核对'], requiredArtifacts: 0 } }).ok);
  assert(m.send({ type: 'ARTIFACT', artifact: { id: 'first-selection', name: 'first.md', content: '第一版业务正文' } }).ok);
  const owner1 = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner1.id, fence: owner1, text: '第一版摘要', artifactIds: ['first-selection'] }).ok);
  const check1 = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check1.id, fence: check1 }).ok);
  assert(m.send({ type: 'WORK_FAILED', intentId: check1.id, reason: '独立检查未完成', transient: false }).ok);
  assert.equal(m.c.outcome, 'partial'); const first = structuredClone(m.c.resilience!.frozen)!;
  const firstShadow = m.c.artifacts.find(a => a.content === '第一版摘要')!; assert(firstShadow); const frozenShadow = structuredClone(firstShadow);
  assert(m.send({ type: 'CONTINUE' }).ok);
  assert(m.send({ type: 'ARTIFACT', artifact: { id: 'current-selection', name: 'second.md', content: '第二版业务正文' } }).ok);
  const owner2 = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner2.id, fence: owner2, text: '第二版摘要', artifactIds: ['current-selection'] }).ok);
  const check2 = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check2.id, fence: check2 }).ok);
  assert(m.send({ type: 'WORK_FAILED', intentId: check2.id, reason: '第二次独立检查未完成', transient: false }).ok);
  assert.equal(m.c.outcome, 'partial'); assert.equal(new Set(m.c.artifacts.map(a => a.id)).size, m.c.artifacts.length);
  const published = publicationIds(m.c)!; const selectedText = published.map(id => m.c.artifacts.find(a => a.id === id)!.content);
  assert(selectedText.includes('第二版摘要')); assert(!selectedText.includes('第一版摘要')); assert(!published.includes(firstShadow.id));
  assert.deepEqual(m.c.artifacts.find(a => a.id === firstShadow.id), frozenShadow); assert.deepEqual(m.c.resilience!.frozenHistory![0], first);
  assert.notEqual(m.c.resilience!.frozen!.id, first.id); return m;
}
export function resilienceClarificationGate(mode: 'reply' | 'skip' | 'skipHelp' | 'replyHelp') {
  let m: ResilienceModel;
  if (mode.endsWith('Help')) m = resilienceRetryGateBinding(true);
  else {
    m = new ResilienceModel(); const seed = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20, repairLimit: 2 }; }); m.snapshot = seed.snapshot;
    const work = m.claim('interpretation'), { decomposition: _decomposition, ...spec } = capacityModelIntent();
    assert(m.send({ type: 'INTERPRETATION_RESULT', workId: work.id, fence: work, inputId: (work.payload.input as { id: string }).id,
      spec: { ...spec, clarification: '请选择方案甲还是乙' } }).ok);
  }
  const gate = taskHumanGate(m.c)!, window = structuredClone(processingWindow(m.c)); assert.equal(gate.kind, 'clarification');
  const skip = mode.startsWith('skip'); assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: skip ? 'skip' : 'reply', text: skip ? '明确忽略该澄清内容' : '选择方案甲' }).ok);
  assert(!taskHumanGate(m.c)); assert.deepEqual(processingWindow(m.c), window);
  assert(m.c.inputAnalyses!.some(input => input.workId === gate.workId && input.status === 'cancelled'));
  if (!skip) {
    assert.equal(m.phase, 'interpreting'); const parse = m.claim('interpretation');
    assert.equal((parse.payload.input as { rawText: string }).rawText, '选择方案甲');
    assert(m.send({ type: 'INTERPRETATION_RESULT', workId: parse.id, fence: parse, inputId: (parse.payload.input as { id: string }).id,
      spec: { action: 'supplement', objective: '选择方案甲', constraints: [], expectedOutputs: ['报告'], acceptanceCriteria: ['可核对'], references: [], confidence: 1, clarification: null } }).ok);
    if (mode === 'replyHelp') assert.equal(m.pending('assistance').length, 0, 'Superseded unstarted help cannot remain a ghost promise');
  } else if (mode === 'skipHelp') {
    assert.equal(m.phase, 'waitingAssistance'); const help = m.claim('assistance'), requestId = String(help.payload.requestId);
    assert(m.send({ type: 'RECORD_RESULT', workId: help.id, fence: help, requestId, resultId: 'after-clarification-skip', status: 'success', answer: '已取得独立核查意见' }).ok);
    assert(m.send({ type: 'HELP_RESULT', requestId, resultId: 'after-clarification-skip', status: 'success', answer: '已取得独立核查意见' }).ok);
  }
  assert.equal(m.phase, 'running'); assert.equal(m.pending('owner').length, 1); m.claim('owner'); assert.equal(m.pending('assistance').length, 0);
  assert.equal(m.c.resilience!.window.repairUsed, 0, 'A clear answer must progress without fallback repair'); return m;
}
export function taskResilienceModelGate() {
  const phases = resiliencePhaseGate(); resilienceWindowGate(); resilienceHumanGate(); resilienceHumanGate(true); resilienceCleanupGate(); resilienceStopGate();
  for (const stage of ['planning', 'collecting', 'summarizing', 'ready']) resilienceContinueGate(stage);
  resilienceSavedResultGate(); resilienceDeadlineGate(false); resilienceDeadlineGate(true); resilienceLegacyGate();
  resilienceReceiptContinuationGate();
  resilienceReviewReplyGate(); resilienceReviewRetryGate();
  const businessDeadlines = resilienceResultDeadlineGate();
  const recoveredCustody = resilienceRecoveredCustodyGate();
  resilienceSkippedCompletionGate(); resilienceCleanupResourceGate(false); resilienceCleanupResourceGate(true); resilienceLegacyUnsafeGate(); resilienceLegacyUnsafeGate(true);
  resilienceRetryGateBinding(false); resilienceRetryGateBinding(true);
  resilienceRepeatedPartialGate();
  const clarificationReplies = (['reply', 'skip', 'skipHelp', 'replyHelp'] as const).map(mode => { const m = resilienceClarificationGate(mode); return { mode, phase: m.phase, owner: m.c.owner, repairUsed: m.c.resilience!.window.repairUsed }; });
  const notStartedLifecycle = (['已请求停止', '已发布partial', '已经complete'] as const).map(logical => { const m = resilienceNotStartedLifecycleGate(logical); return { logical, outcome: m.c.outcome }; });
  const requiredFailures = (['owner', 'interpretation', 'assistance', 'facilitator', 'check'] as const).flatMap(role => [false, true].map(expired => { const m = resilienceRequiredFailureGate(role, true, expired); return { role, expired, phase: m.phase, outcome: m.c.outcome }; }));
  const directResponses = (['input', 'retry'] as const).flatMap(kind => [false, true].map(expired => { const m = resilienceDirectResponseGate(kind, expired); return { kind, expired, phase: m.phase, outcome: m.c.outcome }; }));
  return { phases, businessDeadlines, recoveredCustody, directResponses, requiredFailures, notStartedLifecycle, clarificationReplies, gates: ['fixedWindow', 'requiredHuman', 'expiredReply', 'explicitNewWindow', 'cleanupCustody', 'lateReceiptFreeze', 'stopRecoveryOrders', 'continueEpochFourStages', 'savedResultReactivation', 'deadlineOrder', 'legacyFixedWindow'], persistence: 'real taskMachine round trip after every public event' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(taskResilienceModelGate(), null, 2));
