import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ResilienceModel } from './task-resilience-model-fixture.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';

export function configurationRecoveryModel(materials = true, physical = false) {
  const m = new ResilienceModel(); if (materials) m.artifact(); if (physical) m.unknown();
  const original = structuredClone(processingWindow(m.c)), changed = structuredClone(m.c.config); changed.toolVersion = 'incompatible-new-tools';
  assert.equal(m.send({ type: 'RECOVER', config: changed }).code, 'INCOMPATIBLE_EXECUTION');
  const gate = taskHumanGate(m.c)!; assert(gate); assert.equal(gate.cause, 'incompatibleExecution');
  assert.deepEqual(gate.decisions, ['skip', 'stop']); assert.equal(m.phase, 'waitingHuman');
  assert.equal(m.c.outcome, null); assert.deepEqual(processingWindow(m.c), original);
  return m;
}
export function configurationResponseGate(response: string, m = configurationRecoveryModel()) {
  const gate = taskHumanGate(m.c)!, before = structuredClone(processingWindow(m.c));
  if (response === '普通补充') assert(m.send({ type: 'USER_INPUT', text: '继续处理' }).ok);
  else if (response === '普通人类决定') assert(m.send({ type: 'HUMAN_DECISION', text: '继续处理' }).ok);
  else if (response === '继续命令') assert.equal(m.send({ type: 'CONTINUE' }).ok, false);
  else assert.equal(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: response.includes('新窗口') ? 'newWindow' : 'reply', text: '继续', newWindowMs: 100 }).code, 'HUMAN_GATE_DECISION_NOT_ALLOWED');
  assert.equal(m.phase, 'waitingHuman'); assert.equal(taskHumanGate(m.c)?.id, gate.id); assert.equal(m.c.outcome, null);
  assert.deepEqual(processingWindow(m.c), before); return m;
}
export function configurationSkipGate(materials: string, m = configurationRecoveryModel(materials !== '没有可用成果', materials.includes('未知操作'))) {
  const gate = taskHumanGate(m.c)!;
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确省略当前不兼容任务剩余业务' }).ok);
  assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, materials === '没有可用成果' ? 'failed' : 'partial');
  assert(m.c.resilience!.frozen!.skippedIds.length); assert(m.c.resilience!.skips.some(s => s.gateId === gate.id));
  if (materials.includes('未知操作')) { assert(m.c.resilience!.cleanup.some(item => item.state === 'pending')); assert(m.c.resilience!.gates.some(g => g.scope === 'cleanup' && g.status === 'open')); }
  return m;
}
export function configurationCleanupWakeGate(m = configurationRecoveryModel(true, true)) {
  const gate = taskHumanGate(m.c)!, before = structuredClone(processingWindow(m.c));
  assert(m.supervise(101).ok); const first = m.c.resilience!.nextSupervisionAt!;
  assert.equal(taskHumanGate(m.c)?.id, gate.id); assert(m.c.resilience!.cleanup.some(item => item.state === 'pending'));
  assert(first > m.at); assert(m.supervise(first).ok); assert(m.c.resilience!.nextSupervisionAt! > first);
  assert.deepEqual(processingWindow(m.c), before); assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); return m;
}
export function verifyConfigurationRecovery() {
  const responses = ['普通补充', '普通人类决定', '继续命令', '门的普通答复', '门的新窗口请求'].map(response => { const m = configurationResponseGate(response); return { response, phase: m.phase, decisions: taskHumanGate(m.c)!.decisions }; });
  const skips = ['已保存当前成果', '没有可用成果', '已保存成果并有未知操作'].map(materials => { const m = configurationSkipGate(materials); return { materials, outcome: m.c.outcome, cleanup: m.c.resilience!.cleanup.length }; });
  const cleanup = configurationCleanupWakeGate(); return { responses, skips, cleanup: { phase: cleanup.phase, nextWake: cleanup.c.resilience!.nextSupervisionAt } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyConfigurationRecovery(), null, 2));
