import assert from 'node:assert/strict';
import { persistTask, restoreTask, startTaskExecution, taskPhase } from '../src/task.machine.js';
import { processingWindow, taskHumanGate, effectiveWork } from '../src/task/resilience.js';
import { ResilienceModel, resiliencePhaseGate, resilienceWindowGate, resilienceHumanGate, resilienceCleanupGate,
  resilienceContinueGate, resilienceSavedResultGate, resilienceDirectResponseGate, resilienceSkippedCompletionGate, resilienceLegacyUnsafeGate, resilienceRetryGateBinding, resilienceRequiredFailureGate, resilienceNotStartedLifecycleGate, resilienceRepeatedPartialGate, resilienceClarificationGate, resilienceReceiptContinuationGate, resilienceDeadlineGate, resilienceLegacyGate } from './task-resilience-model-fixture.js';
import { notStartedRecoveryModel, type RecoveryRole } from './execution-recovery-model-fixture.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import { clarificationReplyEngineAcceptance } from './clarification-reply-acceptance.js';
import type { Candidate, Phase } from '../src/types.js';

const roles: Record<string, RecoveryRole> = { 输入解析: '输入解析', 负责人执行: '负责人', 成员协助: '协助成员', 系统协调: '系统协调员', 系统协调员: '系统协调员', 讨论汇总: '讨论汇总', 最终检查: '交付检查' };
export interface ResilienceProof { model: ResilienceModel; detail: string; beforeDeadline: number; beforeUsage: number; alternative?: unknown }
function wrap(model: ResilienceModel, detail: string, alternative?: unknown): ResilienceProof {
  return { model, detail, beforeDeadline: processingWindow(model.c).hardDeadline, beforeUsage: model.c.usage.ordinary, ...(alternative === undefined ? {} : { alternative }) };
}
function fromSnapshot(snapshot: ResilienceModel['snapshot']) { const m = new ResilienceModel(); m.snapshot = snapshot; return m; }
function knownMaterials() {
  const m = new ResilienceModel(input => { input.config.limits.ordinary = 2; input.config.limits.checks = 1; });
  m.artifact(); const owner = m.claim();
  assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '已检查的材料', artifactIds: ['current-artifact'] }).ok);
  const check = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check }).ok);
  const candidate = check.payload.candidate as Candidate;
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, candidateRevision: candidate.revision, resultId: 'verified-materials', criteriaResults: fixtureCheck(candidate).criteriaResults }).ok);
  assert.equal(m.c.outcome, 'complete'); assert(m.send({ type: 'CONTINUE' }).ok); m.claim(); return m;
}
function optionalPartition() {
  const seed = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 1000, repairTimeoutMs: 100, repairLimit: 2, allowMissingContent: true }; });
  seed.claim(); seed.consume(); assert(seed.interpret(capacityModelIntent()).ok);
  const m = fromSnapshot(seed.snapshot), work = m.claim('assistance');
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'partition-op', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['read.js'] }, parentAttempt: work.attempt, fence: work, messages: [], workspaceId: 'partition-resource' }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'partition-op', parentAttempt: work.attempt, fence: work, sessionId: 'partition-session', leaseAvailable: true }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'partition-op', sessionId: 'partition-session', effectsKnown: false, settled: true, result: { ok: false, code: 'timeout', data: {} } }).ok);
  return m;
}
/** Scenario preparation is explicit data; the action uses only real public model events. */
export async function runResilienceAcceptance(id: string, detail: string): Promise<ResilienceProof> {
  if (id === 'BT_Y01') return wrap(resilienceWindowGate(), detail);
  if (id === 'BT_Y02') { const rows = resiliencePhaseGate(); const m = new ResilienceModel(); m.supervise(101); return wrap(m, detail, rows.find(row => row.phase === detail)); }
  if (id === 'BT_Y03') {
    const run = notStartedRecoveryModel(roles[detail]!); const m = fromSnapshot(run.snapshot);
    if (m.c.outcome === null) {
      const next = effectiveWork(m.c, m.phase, run.result.role === '交付检查' ? 1 : m.c.lastActivityAt)[0];
      if (next?.status === 'pending') { m.at = m.c.lastActivityAt; const work = m.claim(next.kind); const permit = startTaskExecution(m.snapshot, work.id, work.attempt, m.at); assert(permit.allowed); m.snapshot = permit.snapshot; }
      m.supervise(processingWindow(m.c).hardDeadline + 1);
    }
    return wrap(m, detail);
  }
  if (id === 'BT_Y04' && detail === '检查提供方权限缺失') { const m = resilienceRequiredFailureGate('check'); return wrap(m, detail); }
  if (id === 'BT_Y04') { const m = new ResilienceModel(); const gate = m.waiting(); m.supervise(101); assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); m.supervise(200); return wrap(m, detail, gate.id); }
  if (id === 'BT_Y05') {
    if (detail.startsWith('澄清门')) {
      const mode = detail.includes('重新评估') ? 'replyHelp' : detail.includes('已批准') ? 'skipHelp' : detail.includes('跳过') ? 'skip' : 'reply';
      return wrap(resilienceClarificationGate(mode), detail, await clarificationReplyEngineAcceptance(mode));
    }
    if (detail === '精确关联失败成员的配置门重试' || detail === '无关必需目标门下的成员重试') return wrap(resilienceRetryGateBinding(detail.startsWith('无关')), detail);
    if (detail === '当前门的明确跳过') return wrap(resilienceSkippedCompletionGate(), detail);
    if (detail === '当前门的普通补充答复' || detail === '当前门的明确重试协助') return wrap(resilienceDirectResponseGate(detail.includes('重试') ? 'retry' : 'input'), detail);
    const m = new ResilienceModel(), gate = m.waiting();
    if (detail === '旧目标的门答复') {
      assert(m.send({ type: 'USER_INPUT', text: '切换目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
      assert.equal(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'reply', text: '旧答复' }).ok, false);
    } else if (detail === '只关闭界面提示') m.snapshot = restoreTask(structuredClone(persistTask(m.snapshot)));
    else {
      const body = { type: 'HUMAN_GATE_DECISION', id: 'fixed-response', gateId: gate.id, decision: detail.includes('跳过') ? 'skip' : 'reply', text: '采用甲' };
      assert(m.send(body).ok);
      if (detail === '当前门的重复答复') { const count = m.pending('owner').length; assert(m.send(body).ok); assert.equal(m.pending('owner').length, count); }
      if (detail === '已关闭门的答复') assert.equal(m.send({ ...body, id: 'different-response' }).ok, false);
    }
    return wrap(m, detail, gate.id);
  }
  if (id === 'BT_Y06') {
    if (detail.includes('新的')) return wrap(resilienceHumanGate(true), detail);
    if (!detail.includes('跳过')) return wrap(resilienceHumanGate(false), detail);
    const m = new ResilienceModel(); m.artifact(); const gate = m.waiting(); m.supervise(101);
    assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确省略该内容' }).ok); return wrap(m, detail);
  }
  if (id === 'BT_Y07') { const m = optionalPartition(); assert(m.supervise().ok); return wrap(m, detail); }
  if (id === 'BT_Y08') { const m = knownMaterials(); m.supervise(101); return wrap(m, detail); }
  if (id === 'BT_Y09') { const m = new ResilienceModel(); m.claim(); m.supervise(101); return wrap(m, detail); }
  if (id === 'BT_Y111') return wrap(resilienceNotStartedLifecycleGate(detail as '已请求停止' | '已发布partial' | '已经complete'), detail);
  if (id === 'BT_Y113') return wrap(resilienceReceiptContinuationGate(), detail);
  if (id === 'BT_Y10') {
    if (detail.includes('再次')) return wrap(resilienceRepeatedPartialGate(), detail);
    const m = new ResilienceModel(); m.artifact('old-goal');
    assert(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '当前目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
    m.artifact('current-selection'); const w = m.claim();
    assert(m.send({ type: 'DELIVER', workId: w.id, fence: w, text: '当前草稿', artifactIds: ['current-selection'] }).ok); m.supervise(101); return wrap(m, detail);
  }
  if (id === 'BT_Y11' && detail.includes('没有CLI')) return wrap(resilienceLegacyUnsafeGate(detail.startsWith('已停止')), detail);
  if (id === 'BT_Y11') { const m = new ResilienceModel(); m.artifact(); m.unknown(); if (detail.includes('取消')) assert(m.send({ type: 'STOP' }).ok); else m.supervise(101); return wrap(m, detail); }
  if (id === 'BT_Y12') {
    const m = resilienceCleanupGate(), frozen = structuredClone(m.c.resilience!.frozen);
    if (detail === '重启恢复') assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    else if (detail === '检查通过') m.send({ type: 'CHECK_RESULT', workId: m.c.intents[0]!.id, candidateRevision: 'late', resultId: 'late-check', criteriaResults: [] });
    else if (detail === '旧负责人交付') m.send({ type: 'DELIVER', workId: m.c.intents[0]!.id, text: '迟到全部完成', artifactIds: [] });
    else m.supervise(200);
    assert.deepEqual(m.c.resilience!.frozen, frozen); return wrap(m, detail, frozen);
  }
  if (id === 'BT_Y13') { const run = notStartedRecoveryModel(roles[detail]!); return wrap(fromSnapshot(run.snapshot), detail, run.result); }
  if (id === 'BT_Y14') return wrap(resilienceContinueGate(detail), detail);
  if (id === 'BT_Y15') {
    const m = new ResilienceModel(), work = m.unknown();
    if (detail.startsWith('恢复')) assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert(m.send({ type: 'STOP' }).ok); if (detail.includes('停止后恢复')) assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'unknown-op', sessionId: 'unknown-session', settled: true, effectsKnown: true, result: { ok: false, code: 'known-failure', data: {} } }).ok);
    if (detail.endsWith('再恢复')) assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); return wrap(m, detail);
  }
  if (id === 'BT_Y16') return wrap(resilienceSavedResultGate(), detail);
  if (id === 'BT_Y17') return wrap(resilienceDeadlineGate(detail.startsWith('先监督')), detail);
  if (id === 'BT_Y18') {
    if (detail.includes('临时')) {
      const { temporaryClaimRecoveryAcceptance } = await import('./partition-resilience-acceptance.js'); const result = await temporaryClaimRecoveryAcceptance();
      const m = new ResilienceModel(); m.supervise(101); return wrap(m, detail, result);
    }
    const m = new ResilienceModel(input => { if (detail === '预算不足') input.config.limits.ordinary = 0; });
    if (detail !== '预算不足') {
      // Explicit historical fixture: snapshots produced by the reported stale/phase/permit defects.
      const saved = structuredClone(persistTask(m.snapshot)) as { context: ResilienceModel['c']; value: Phase };
      if (detail === '旧目标或旧轮次') saved.context.intents[0]!.epoch = 0;
      if (detail === '工作阶段不允许领取') saved.value = 'coordinating';
      if (detail === '没有有效执行许可') { saved.context.intents[0]!.status = 'done'; saved.value = 'coordinating'; }
      m.snapshot = restoreTask(saved);
    }
    m.supervise(); m.supervise(101); return wrap(m, detail);
  }
  if (id === 'BT_Y19') {
    const m = new ResilienceModel(); m.artifact();
    if (detail.includes('人类')) { const gate = m.waiting(); m.at = 101; assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: detail.includes('跳过') ? 'skip' : 'reply', text: '当前明确决定' }).ok); }
    else if (detail === '新目标输入') { assert(m.send({ type: 'USER_INPUT', text: '当前新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok); m.supervise(101); }
    else { m.supervise(101); m.send({ type: 'CHECK_RESULT', workId: m.c.intents[0]!.id, resultId: 'old-check', candidateRevision: 'old', criteriaResults: [] }); }
    const frozen = structuredClone(m.c.resilience!.frozen); const response = m.send({ type: 'USER_INPUT', text: '冻结后的新目标', goal: { text: '晚目标', constraints: [], criteria: [], requiredArtifacts: 0 } });
    assert.equal(response.code, 'FROZEN_DELIVERY'); assert.deepEqual(m.c.resilience!.frozen, frozen); return wrap(m, detail);
  }
  if (id === 'BT_Y20') { const m = resilienceLegacyGate(); m.artifact(); m.unknown(); m.supervise(101); return wrap(m, detail); }
  throw new Error(`Unimplemented resilience contract ${id}`);
}
export function assertResilienceConsequence(id: string, proof: ResilienceProof): void {
  const { model: m, detail } = proof;
  if (id === 'BT_Y113') { assert.equal(m.phase, 'running'); assert.equal(m.c.intents.filter(work => work.kind === 'owner').length, 1); assert(m.c.intents.find(work => work.kind === 'owner')!.localCheckpoint!.messages.some(message => message.content.includes('CLI_EFFECTS_RECONCILED'))); return; }
  if (id === 'BT_Y111') { assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, detail === '已请求停止' ? 'stopped' : detail === '已发布partial' ? 'partial' : 'complete'); assert.equal(m.pending('owner').length, 0); return; }
  if (id === 'BT_Y04') { assert.equal(m.phase, 'waitingHuman'); assert(taskHumanGate(m.c)); assert.equal(m.c.resilience!.nextSupervisionAt, null); return; }
  if (id === 'BT_Y05') {
    const gates = m.c.resilience!.gates; assert(gates.length > 0);
    if (detail.includes('关闭界面')) assert(gates.some(g => g.status === 'open' && !g.responseId));
    else if (detail.startsWith('无关')) assert(taskHumanGate(m.c));
    else if (!detail.includes('旧目标')) assert(gates.some(g => ['answered', 'skipped'].includes(g.status))); return;
  }
  if (id === 'BT_Y06' && detail.includes('新的')) { assert.equal(processingWindow(m.c).hardDeadline, 151); assert.equal(m.c.outcome, null); assert(effectiveWork(m.c, m.phase, m.at).length); return; }
  if (id === 'BT_Y07') {
    assert(m.c.resilience!.skips.some(s => s.targetKind === 'partition' && s.authorization === 'policy'));
    assert(m.c.resilience!.cleanup.some(item => item.state === 'pending')); assert(effectiveWork(m.c, m.phase, m.at).length > 0);
    assert(m.c.discussion!.mapReduce!.queue!.some(part => part.status === 'cancelled')); return;
  }
  if (id === 'BT_Y13') { assert(m.c.outcome !== null || effectiveWork(m.c, m.phase, m.c.lastActivityAt).length > 0 || taskHumanGate(m.c)); return; }
  if (id === 'BT_Y14' || id === 'BT_Y16') { assert.equal(m.phase, 'running'); assert.equal(m.c.outcome, null); assert(effectiveWork(m.c, m.phase, m.at).length > 0); return; }
  if (id === 'BT_Y17') { assert.equal(m.c.assists[0]!.status, 'timeout'); assert.equal(m.c.consumedResults.length, 1); assert(m.c.lateResults.length); return; }
  assert.equal(m.phase, 'ended'); assert(m.c.outcome !== null); assert(m.c.resilience!.frozen);
  assert.equal(m.c.resilience!.frozen!.goalVersion, m.c.goalVersion); assert.equal(m.c.resilience!.frozen!.verification, 'incomplete');
  if (id === 'BT_Y09') assert.equal(m.c.outcome, 'failed');
  if (id === 'BT_Y10') { assert.equal(new Set(m.c.artifacts.map(a => a.id)).size, m.c.artifacts.length); assert(!m.c.resilience!.frozen!.artifactIds.includes('old-goal')); assert(m.c.resilience!.frozen!.artifactIds.includes('current-selection')); }
  if (id === 'BT_Y11' || id === 'BT_Y20') { assert(m.c.resilience!.cleanup.length > 0); assert(m.c.resilience!.gates.some(g => g.scope === 'cleanup')); }
  if (id === 'BT_Y15') assert.equal(m.c.outcome, 'stopped');
  if (id === 'BT_Y08' || id === 'BT_Y10') assert(m.c.resilience!.frozen!.text.includes('partial'));
}
