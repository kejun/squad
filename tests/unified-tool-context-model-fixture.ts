import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { localPhysicalPending } from '../src/local-operation.js';
import { approvalModel, assertApprovedReceipt, assertApprovalBoundary, assertDeniedReceipt,
  assertHostRequestRejected, assertRecoveredApproval, assertWaitingApproval, decideApproval,
  hostAction, recoverApproval } from './host-approval-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { modelGuidanceBoundary } from './tool-guidance-model-fixture.js';

/**
 * BT_Y122 / BT_Y128 model gate. These are real taskMachine transitions, persisted
 * and restored by LocalModel after every event. The directory is a host-side
 * observation: publication, selected-entry freshness and binary/environment
 * hashes are verified by the Runner/Adapter/LocalRuntime acceptance fixtures.
 * No directory state or fabricated execution authority is added to taskMachine.
 */
export function directHostSelectionModel(decision = '尚未决定') {
  const m = approvalModel();
  assertWaitingApproval(m);
  const operations = m.c.intents[0]!.localOperations!;
  assert.equal(operations.length, 1, 'The first local operation may directly select the host');
  assert.deepEqual(operations[0]!.action, hostAction);
  assert.deepEqual(m.c.intents[0]!.toolRecovery?.failures ?? [], []);
  assert.equal(localPhysicalPending(m.c.intents[0]!), false);
  const action = structuredClone(m.op!.action);
  if (decision === '明确批准' || decision === '批准') {
    assert(decideApproval(m).ok);
    assert(m.claim().ok);
    assert(m.started().ok);
    assert(m.result().ok);
    assertApprovedReceipt(m);
  } else if (decision === '明确拒绝' || decision === '拒绝') {
    assert(decideApproval(m, 'deny').ok);
    assertDeniedReceipt(m);
    assert.equal(m.op!.startedAt, undefined);
  } else if (decision === '授权过期') {
    m.at = m.op!.approval!.expiresAt;
    assert.equal(decideApproval(m).code, 'HOST_APPROVAL_EXPIRED');
    assert(m.send({ type: 'LOCAL_APPROVAL_EXPIRED', intentId: m.work.id, operationId: m.op!.id }).ok);
    assert.equal(m.op!.result!.code, 'HOST_APPROVAL_EXPIRED');
    assert.equal(m.op!.startedAt, undefined);
    assert.equal(m.c.usage.ordinary, 1);
  } else {
    assert.equal(decision, '尚未决定');
    assert.equal(m.started().code, 'LOCAL_SESSION_MISMATCH');
    assertWaitingApproval(m);
  }
  assert.deepEqual(m.op!.action, action, 'The exact call cannot change while requesting permission');
  assert.equal(m.c.intents[0]!.localOperations!.length, 1, 'Permission cannot manufacture a sandbox probe');
  return m;
}

const boundaryCodes: Record<string, string> = {
  已停止: 'STOPPED', 旧目标: 'STALE_WORK', 旧轮次: 'STALE_WORK', 已过期: 'WORK_EXPIRED',
  本地工具撤权: 'LOCAL_TOOLS_DISABLED', 成员工具撤权: 'LOCAL_TOOLS_DISABLED',
  效果不明: 'WORK_NOT_INFLIGHT', 最终固定材料检查: 'CHECK_LOCAL_TOOLS_NOT_ALLOWED',
};

export function unifiedToolBoundaryModel(boundary: string) {
  assert(Object.hasOwn(boundaryCodes, boundary), `Unknown unified-tool boundary: ${boundary}`);
  const originalBoundary = boundary === '最终固定材料检查' ? '最终检查' : boundary;
  const { model: m, allowed } = modelGuidanceBoundary(originalBoundary);
  assert.equal(allowed, false);
  const operations = structuredClone(m.c.intents[0]!.localOperations);
  const usage = structuredClone(m.c.usage);
  const reply = m.request(hostAction);
  assert.equal(reply.code, boundaryCodes[boundary]);
  assert.deepEqual(m.c.intents[0]!.localOperations, operations);
  assert.deepEqual(m.c.usage, usage);
  return m;
}

function hostExecutionBudgetModel() {
  const m = new LocalModel(input => { input.config.limits.ordinary = 1; });
  assert(m.request(hostAction).ok);
  assert.equal(m.claim().code, 'BUDGET_EXHAUSTED');
  assert.equal(m.op!.status, 'queued');
  assert.equal(m.op!.startedAt, undefined);
  assert.equal(m.c.usage.ordinary, 1);
  return m;
}

export function unifiedToolContextModelGate() {
  for (const decision of ['尚未决定', '明确批准', '明确拒绝', '授权过期']) directHostSelectionModel(decision);
  for (const boundary of Object.keys(boundaryCodes)) unifiedToolBoundaryModel(boundary);
  assertHostRequestRejected('尚未批准就启动');
  assertApprovalBoundary(approvalModel(), '批准标识不匹配');
  hostExecutionBudgetModel();
  for (const window of ['尚未领取', '领取后确认未启动', '已经启动']) {
    const m = recoverApproval(approvalModel(), window);
    assertRecoveredApproval(m, window === '已经启动' ? '等待核对' : '重新批准');
  }
  return { model: 'real taskMachine; persist/restore after every event', paths: 18,
    directHostDecisions: 4, retainedBoundaries: 8, approvalAndBudgetBoundaries: 3, recoveryWindows: 3,
    hostObservationBoundary: 'catalog publication, entry changes and executable/environment hashes require integration evidence' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(unifiedToolContextModelGate(), null, 2));
