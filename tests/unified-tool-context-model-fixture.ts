import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { localPhysicalPending, validLocalAction, type LocalAction, type HostApproval } from '../src/local-operation.js';
import { approvalModel, assertApprovedReceipt, assertApprovalBoundary, assertDeniedReceipt,
  assertHostRequestRejected, assertRecoveredApproval, assertWaitingApproval, decideApproval,
  hostAction, recoverApproval } from './host-approval-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { modelGuidanceBoundary } from './tool-guidance-model-fixture.js';
import { originalPrivateToolAction } from './fixtures/live-private-tool-response.js';

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
  效果不明: 'WORK_NOT_INFLIGHT', 最终检查本地工具撤权: 'LOCAL_TOOLS_DISABLED',
};

export function unifiedToolBoundaryModel(boundary: string) {
  assert(Object.hasOwn(boundaryCodes, boundary), `Unknown unified-tool boundary: ${boundary}`);
  const originalBoundary = boundary === '最终检查本地工具撤权' ? '本地工具撤权' : boundary;
  const { model: m, allowed } = modelGuidanceBoundary(originalBoundary);
  if (boundary === '最终检查本地工具撤权') m.c.intents[0]!.kind = 'check';
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

/** BT_Y130: adapter-only omission cannot weaken the public protocol or approvals.
 * Unknown non-empty IDs remain a runtime activation question, not a fabricated
 * pure taskMachine rejection. Real @skill bindings are exercised by integration. */
export function optionalSkillIdModelGate() {
  const raw = structuredClone(originalPrivateToolAction);
  const { skillId: _empty, reason: _reason, ...withoutReason } = raw;
  const rejected = [raw, { ...raw, skillId: ' ' }, { ...raw, skillId: null },
    { ...raw, executable: '@skill/scripts/read.js' }, { ...raw, args: ['@skill/scripts/read.js'] },
    { ...raw, cwd: '@skill' }, { ...withoutReason, skillId: '' }, withoutReason,
    { ...raw, cwd: '' }, { ...raw, approved: true }];
  for (const action of rejected) {
    assert.equal(validLocalAction(action), false);
    const m = new LocalModel(), usage = structuredClone(m.c.usage);
    assert.equal(m.request(action as LocalAction).code, 'INVALID_LOCAL_REQUEST');
    assert.equal(m.op, undefined); assert.deepEqual(m.c.usage, usage);
  }
  const { skillId: _unused, ...canonical } = raw;
  assert(validLocalAction(canonical) && canonical.type === 'runCli');
  const m = new LocalModel(); assert(m.request(canonical).ok); assert(m.claim().ok);
  assert.equal(m.started().code, 'HOST_APPROVAL_REQUIRED');
  const approval: HostApproval = { id: 'approval1', digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
    plan: { executable: '/usr/bin/yuque', args: canonical.args, cwd: '/task', workspaceRevision: 'b'.repeat(64),
      executableHash: 'c'.repeat(64), environmentHash: 'e'.repeat(64), host: 'service-host', account: 'user', reason: canonical.reason! } };
  assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval, fence: m.work }).ok);
  assertWaitingApproval(m); assert.equal(Object.hasOwn(m.op!.action, 'skillId'), false);
  assert(decideApproval(m).ok); assert(m.claim().ok); assert(m.started().ok); assert(m.result().ok); assertApprovedReceipt(m);
  for (const skillId of ['unknown-skill', 'local:not-activated']) {
    const action = { ...raw, skillId }; assert(validLocalAction(action));
    const bound = new LocalModel(); assert(bound.request(action).ok);
    assert.equal(bound.op!.action.type, 'runCli'); assert.deepEqual(bound.op!.action, action); assert.equal(bound.op!.startedAt, undefined);
  }
  return { model: 'real taskMachine; persist/restore after every event', paths: 13,
    invalidPublicActionsRejected: rejected.length, canonicalHostApproval: 1, nonemptyIdsRetainedForRuntimeValidation: 2,
    permissionExpansion: false, runtimeBoundary: 'unknown and inactive skill IDs still require the original activation checks' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ existing: unifiedToolContextModelGate(), optionalSkillField: optionalSkillIdModelGate() }, null, 2));
