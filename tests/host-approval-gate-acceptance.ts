import assert from 'node:assert/strict';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';
import type { RoomSnapshot } from '../src/web/contracts.js';
import { modelResponse } from './model-regeneration-fixture.js';

/** Actual OpenAI adapter/local tool preparation, HTTP, journal and SQLite; no approval means no process. */
export async function hostApprovalGateServiceAcceptance(boundary: string) {
  const fixture = new HostApprovalFixture(); await fixture.open();
  try {
    assert(fixture.submit().ok); const approval = await fixture.approval();
    const engine = fixture.service.engine;
    const view = engine.view(fixture.room.id, fixture.taskId)!, before = structuredClone(processingWindow(view.context));
    const gate = taskHumanGate(view.context)!; assert(gate?.operationId === approval.operationId);
    assert(engine.send(fixture.room.id, fixture.taskId, { id: 'expire-execution-token', type: 'LOCAL_APPROVAL_EXPIRED', at: approval.expiresAt,
      intentId: approval.workId, operationId: approval.operationId }).ok);
    if (boundary !== '原批准期限到期') assert(engine.send(fixture.room.id, fixture.taskId, { id: 'hard-window-expired', type: 'SUPERVISE',
      at: before.hardDeadline + 1, trigger: 'timer' }).ok);
    if (boundary === '到期以后重启服务') await fixture.restart(fixture.savedRoom());
    const response = await fetch(fixture.url + fixture.route()); assert.equal(response.status, 200);
    const snapshot = await response.json() as RoomSnapshot;
    const blocker = snapshot.blockers?.find(item => item.id === gate.id); assert(blocker);
    assert.equal(blocker.status, 'open'); assert.equal(blocker.requiredHuman, true); assert.equal(blocker.scope, 'task');
    assert.equal(blocker.operation?.workId, approval.workId); assert.equal(blocker.operation?.operationId, approval.operationId);
    assert(blocker.actions.some(action => action.id === 'skip')); assert(blocker.actions.some(action => action.id === 'stop'));
    assert(!blocker.actions.some(action => action.id === 'newWindow'), 'An execution permission question cannot advertise a window grant as its approval');
    const current = fixture.service.engine.view(fixture.room.id, fixture.taskId)!;
    assert.equal(current.context.outcome, null); assert.equal(taskHumanGate(current.context)?.id, gate.id);
    assert.deepEqual(processingWindow(current.context), { ...before, ...(boundary !== '原批准期限到期' ? { failure: { code: 'WINDOW_EXPIRED', at: before.hardDeadline + 1 } } : {}) }); assert.equal(fixture.operation()!.startedAt, undefined);
    assert.equal(await fixture.runs(), ''); assert.equal(fixture.operation()!.approval!.status, 'expired');
    return { boundary, requiredGateVisible: true, processStarts: 0, outcome: current.context.outcome, exactOperationPreserved: true };
  } finally { await fixture.close(); }
}

export async function hostApprovalGateSkipServiceAcceptance() {
  const fixture = new HostApprovalFixture(); await fixture.open();
  const waits = new Map<string, number>(), wait = fixture.runtime.waitForWorkspace.bind(fixture.runtime);
  fixture.runtime.waitForWorkspace = (key, generation, signal) => {
    waits.set(key, (waits.get(key) ?? 0) + 1);
    return wait(key, generation, signal).finally(() => waits.set(key, (waits.get(key) ?? 1) - 1));
  };
  fixture.beforeOwnerResponse = async () => fixture.requests.length > 1 ? modelResponse({ type: 'askUser', question: '请决定其余独立内容的范围' }) : undefined;
  try {
    fixture.submit(); const approval = await fixture.approval(), key = 'approval:' + approval.operationId;
    await hostUntil(() => waits.get(key) ?? 0, count => count === 1);
    const blocker = fixture.snapshot().blockers!.find(item => item.operation?.operationId === approval.operationId)!; assert(blocker);
    const response = await fetch(fixture.url + fixture.route() + '/blocker-decision', { method: 'POST',
      headers: { origin: fixture.url, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'explicit-web-skip', taskId: fixture.taskId, blockerId: blocker.id, blockerVersion: blocker.version, actionId: 'skip' }) });
    assert.equal(response.status, 200, await response.text());
    await hostUntil(() => waits.get(key) ?? 0, count => count === 0);
    await hostUntil(() => fixture.requests.length, count => count > 1);
    const op = fixture.operation()!; assert.equal(op.id, approval.operationId); assert.equal(op.status, 'cancelled');
    assert.equal(op.startedAt, undefined); assert.notEqual(op.approval!.status, 'approved'); assert.equal(await fixture.runs(), '');
    assert(!fixture.snapshot().hostApprovals?.some(item => item.operationId === approval.operationId));
    assert(fixture.service.engine.view(fixture.room.id, fixture.taskId)!.context.resilience!.skips.some(item => item.gateId === blocker.id));
    return { originalWaiters: 0, nextModelRequest: true, processStarts: 0, originalApprovalCancelled: true };
  } finally { await fixture.close(); }
}
