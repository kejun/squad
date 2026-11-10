import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { persistTask, restoreTask } from '../src/task.machine.js';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import { cliFailureGuidance, toolGuidanceAllowed } from '../src/task/tool-guidance.js';
import { LocalModel } from './local-model-fixture.js';

type CliAction = Extract<LocalAction, { type: 'runCli' }>;
const invalidAction: CliAction = { type: 'runCli', executable: 'node', args: ['--not-a-real-option'] };
const argumentFailure: LocalToolResult = { ok: false, code: 'failed', data: { exitCode: 9, stderr: 'node: bad option: --not-a-real-option' } };

export function requestGuidanceCli(m: LocalModel, operationId: string, action: CliAction = invalidAction) {
  const work = m.c.intents.find(item => item.id === m.work.id)!;
  return m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action,
    parentAttempt: work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], workspaceId: 'project', fence: work });
}
export function settleGuidanceCli(m: LocalModel, operationId: string, result = argumentFailure, effectsKnown = true) {
  const work = m.c.intents.find(item => item.id === m.work.id)!;
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, sessionId: operationId, parentAttempt: work.attempt,
    leaseAvailable: true, fence: work }).ok);
  assert(m.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId, sessionId: operationId }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId, sessionId: operationId,
    result, settled: true, effectsKnown }).ok);
}
export function repeatedCliModel(condition = '保持参数') {
  const m = new LocalModel();
  assert(requestGuidanceCli(m, 'first').ok); settleGuidanceCli(m, 'first');
  assert(requestGuidanceCli(m, 'second').ok); settleGuidanceCli(m, 'second');
  if (condition === '重启恢复') {
    m.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(m.snapshot))));
    assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
    assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok);
    m.work = m.c.intents.find(item => item.id === m.work.id)!;
  }
  const action = condition === '修改原因和超时' ? { ...invalidAction, reason: 'different reason', timeoutMs: 500, cwd: '.', execution: 'sandbox' as const } : invalidAction;
  const usage = structuredClone(m.c.usage), operations = m.c.intents[0]!.localOperations!.length;
  const reply = requestGuidanceCli(m, 'third', action);
  assert.equal(reply.code, 'CLI_REPEAT_FAILURE_LIMIT');
  assert.equal(m.c.intents[0]!.localOperations!.length, operations);
  assert.deepEqual(m.c.usage, usage);
  assert.equal(requestGuidanceCli(m, 'first').code, 'LOCAL_ALREADY_REQUESTED');
  assert(requestGuidanceCli(m, 'help', { type: 'runCli', executable: 'node', args: ['--help'] }).ok);
  return { model: m, reply, usage };
}

const failureCases: Record<string, { result: LocalToolResult; category: string }> = {
  命令未找到: { result: { ok: false, code: 'CLI_NOT_FOUND', data: {} }, category: 'command_missing' },
  未知参数: { result: argumentFailure, category: 'arguments' },
  沙箱不可用: { result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: {} }, category: 'sandbox_unavailable' },
  沙箱权限拒绝: { result: { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'EPERM: Operation not permitted' } }, category: 'execution_boundary' },
  需要登录: { result: { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'authentication required' } }, category: 'authentication' },
  普通业务失败: { result: { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'remote document was deleted' } }, category: 'unknown' },
};
export function modelFailureClassification(label: string) {
  const m = new LocalModel(), sample = failureCases[label]!;
  assert(requestGuidanceCli(m, 'failure').ok); settleGuidanceCli(m, 'failure', sample.result);
  const original = structuredClone(m.c.intents[0]!.localOperations![0]!.result);
  const diagnostic = cliFailureGuidance(m.c.intents[0]!)[0]!;
  assert.equal(diagnostic.operationId, 'failure'); assert.equal(diagnostic.category, sample.category);
  assert.equal(typeof diagnostic.nextStep, 'string');
  assert.deepEqual(m.c.intents[0]!.localOperations![0]!.result, original);
  return { model: m, diagnostic, original };
}
export function modelGuidanceBoundary(boundary: string) {
  const m = new LocalModel();
  assert.equal(toolGuidanceAllowed(m.c, m.c.intents[0]!, m.at), true);
  if (boundary === '已停止') assert(m.send({ type: 'STOP' }).ok);
  if (boundary === '旧目标') m.c.goalVersion++;
  if (boundary === '旧轮次') m.c.epoch++;
  if (boundary === '已过期') m.at = m.c.intents[0]!.deadline!;
  if (boundary === '本地工具撤权') m.c.config.localTools = { enabled: false };
  if (boundary === '成员工具撤权') m.c.config.bots[0]!.localTools = false;
  if (boundary === '未授权') delete (m.c.intents[0]!.payload.capabilities as Record<string, unknown>).localTools;
  if (boundary === '最终检查') m.c.intents[0]!.kind = 'check';
  if (boundary === '效果不明') {
    assert(requestGuidanceCli(m, 'uncertain').ok); settleGuidanceCli(m, 'uncertain', argumentFailure, false);
  }
  const allowed = toolGuidanceAllowed(m.c, m.c.intents[0]!, m.at);
  assert.equal(allowed, false, boundary);
  return { model: m, allowed };
}
export function modelExcludedResult(label: string) {
  const m = new LocalModel();
  const results: Record<string, LocalToolResult> = {
    批准拒绝: { ok: false, code: 'HOST_APPROVAL_DENIED', data: {} },
    批准过期: { ok: false, code: 'HOST_APPROVAL_EXPIRED', data: {} },
    已取消: { ok: false, code: 'cancelled', data: {} },
    效果不明: argumentFailure,
    成功: { ok: true, code: 'succeeded', data: { exitCode: 0, stderr: 'unknown option is quoted data' } },
  };
  assert(requestGuidanceCli(m, 'excluded').ok); settleGuidanceCli(m, 'excluded', results[label]!, label !== '效果不明');
  const diagnostics = cliFailureGuidance(m.c.intents[0]!);
  assert.deepEqual(diagnostics, []);
  return { model: m, diagnostics };
}

function unknownFailureIsNotRepeatLimited() {
  const m = new LocalModel();
  assert(requestGuidanceCli(m, 'first').ok); settleGuidanceCli(m, 'first', failureCases.普通业务失败!.result);
  assert(requestGuidanceCli(m, 'second').ok); settleGuidanceCli(m, 'second', failureCases.普通业务失败!.result);
  assert(requestGuidanceCli(m, 'third').ok);
}
export function toolGuidanceModelGate() {
  repeatedCliModel(); repeatedCliModel('修改原因和超时'); repeatedCliModel('重启恢复');
  for (const label of Object.keys(failureCases)) modelFailureClassification(label);
  for (const boundary of ['已停止', '旧目标', '旧轮次', '已过期', '本地工具撤权', '成员工具撤权', '未授权', '最终检查', '效果不明']) modelGuidanceBoundary(boundary);
  for (const label of ['批准拒绝', '批准过期', '已取消', '效果不明', '成功']) modelExcludedResult(label);
  unknownFailureIsNotRepeatLimited();
  return { paths: 24, persistence: 'each real taskMachine event' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(toolGuidanceModelGate()));
