import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { LocalOperation } from '../src/local-operation.js';
import { effectiveWork, processingWindow, supervisionDecision } from '../src/task/resilience.js';
import type { Intent } from '../src/types.js';
import { ResilienceModel } from './task-resilience-model-fixture.js';

type WaitingOperation = LocalOperation & { workspaceWait?: { since: number } };
export const workspaceWaitBoundaries = ['等待期间监督', '持久化恢复', '资源释放后领取', '用户停止', '自动窗口到期', '旧轮次领取'] as const;
export type WorkspaceWaitBoundary = typeof workspaceWaitBoundaries[number];

export class WorkspaceWaitModel {
  readonly model = new ResilienceModel();
  readonly work = this.model.claim();
  readonly window = structuredClone(processingWindow(this.model.c));
  readonly usage = structuredClone(this.model.c.usage);
  readonly operationId = 'resource-wait-operation';
  readonly since = this.model.at;
  boundary?: WorkspaceWaitBoundary;
  waitingWork: Intent[] = [];
  waitingDecision?: ReturnType<typeof supervisionDecision>;
  initialWait?: WaitingOperation['workspaceWait'];
  invalidClaims: { code: string; createdWait: boolean }[] = [];

  constructor(blocked = true) {
    assert(this.model.send({ type: 'LOCAL_REQUEST', intentId: this.work.id, operationId: this.operationId,
      namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), parentAttempt: this.work.attempt, fence: this.work,
      action: { type: 'runCli', executable: 'yuque', args: ['--help'], execution: 'host', reason: '需要宿主已有命令环境' },
      messages: [], workspaceId: 'shared-resource' }).ok);
    if (blocked) {
      assert.equal(this.claim(false).code, 'WORKSPACE_BUSY');
      assert.equal(this.operation.status, 'queued');
      assert.equal(this.operation.approval, undefined);
      this.initialWait = structuredClone(this.operation.workspaceWait);
    }
  }
  get operation(): WaitingOperation {
    return this.model.c.intents.find(work => work.id === this.work.id)!.localOperations!.find(op => op.id === this.operationId)!;
  }
  claim(leaseAvailable: boolean, extra: Record<string, unknown> = {}) {
    return this.model.send({ type: 'LOCAL_CLAIM', intentId: this.work.id, operationId: this.operationId,
      parentAttempt: this.work.attempt, fence: this.work, sessionId: 'resource-wait-session', leaseAvailable, ...extra });
  }
  exercise(boundary: WorkspaceWaitBoundary) {
    this.boundary = boundary;
    this.waitingWork = effectiveWork(this.model.c, this.model.phase, this.model.at);
    this.waitingDecision = supervisionDecision(this.model.c, this.model.phase, this.model.at);
    if (boundary === '等待期间监督') {
      this.model.supervise(10); this.model.supervise(30);
      assert.equal(this.claim(false).code, 'WORKSPACE_BUSY');
    } else if (boundary === '持久化恢复') {
      this.model.at = 5;
      assert(this.model.send({ type: 'RECOVER', config: this.model.c.config }).ok);
      this.model.supervise(10);
    } else if (boundary === '资源释放后领取') {
      this.model.at = 5; assert(this.claim(true).ok);
    } else if (boundary === '用户停止') {
      this.model.at = 5; assert(this.model.send({ type: 'STOP' }).ok);
      assert(this.model.supervise(6).ok);
    } else if (boundary === '自动窗口到期') {
      assert(this.model.supervise(this.window.hardDeadline).ok);
    } else {
      const untouched = new WorkspaceWaitModel(false);
      const staleFence = untouched.claim(false, { fence: { epoch: 0, goalVersion: 0 } });
      this.invalidClaims.push({ code: staleFence.code, createdWait: !!untouched.operation.workspaceWait });
      const staleAttempt = untouched.claim(false, { parentAttempt: this.work.attempt + 1 });
      this.invalidClaims.push({ code: staleAttempt.code, createdWait: !!untouched.operation.workspaceWait });
      this.model.at = 5;
      assert(this.model.send({ type: 'USER_INPUT', text: '改成新的目标', goal: {
        text: '新的目标', constraints: [], criteria: ['按新目标交付'], requiredArtifacts: 0,
      } }).ok);
      assert.equal(this.claim(false).ok, false);
    }
  }
}

export function assertWorkspaceWaitQualification(proof: WorkspaceWaitModel) {
  assert.deepEqual(proof.initialWait, { since: proof.since }, 'A real resource rejection must persist the initial waiting fact');
  assert.equal(proof.waitingWork.some(work => work.id === proof.work.id), false, 'An unclaimed CLI must not count as effective execution');
  assert.equal(proof.waitingDecision, 'resources', 'Resource waiting must be distinct from execution and fallback repair');
}

export function assertWorkspaceWaitBoundary(proof: WorkspaceWaitModel) {
  const { model, operation, boundary } = proof;
  assert.equal(processingWindow(model.c).hardDeadline, proof.window.hardDeadline);
  assert.equal(processingWindow(model.c).repairUsed, proof.window.repairUsed);
  assert.deepEqual(model.c.usage, proof.usage, 'Waiting, host preparation and cancellation must not consume model or retry budget');
  assert.equal(operation.startedAt, undefined);
  assert.equal(operation.approval, undefined, 'Queued resource waiting is not a pending host approval');
  if (boundary === '等待期间监督' || boundary === '持久化恢复') {
    assert.equal(operation.status, 'queued');
    assert.deepEqual(operation.workspaceWait, { since: proof.since });
    assert.equal(effectiveWork(model.c, model.phase, model.at).some(work => work.id === proof.work.id), false);
    assert.equal(model.c.outcome, null);
    assert.equal(model.c.intents.filter(work => work.kind === 'facilitator').length, 0);
    assert(model.c.resilience!.nextSupervisionAt! <= proof.window.hardDeadline);
  } else if (boundary === '资源释放后领取') {
    assert.equal(operation.status, 'claimed');
    assert.equal(operation.workspaceWait, undefined);
    assert.equal(effectiveWork(model.c, model.phase, model.at).some(work => work.id === proof.work.id), true);
  } else {
    assert.equal(operation.status, 'cancelled');
    assert.equal(effectiveWork(model.c, model.phase, model.at).some(work => work.id === proof.work.id), false);
    if (boundary === '用户停止') assert.equal(model.c.outcome, 'stopped');
    if (boundary === '自动窗口到期') assert.equal(model.c.outcome, 'failed');
    if (boundary === '旧轮次领取') {
      assert.deepEqual(proof.invalidClaims, [
        { code: 'STALE_FENCE', createdWait: false },
        { code: 'WORK_NOT_INFLIGHT', createdWait: false },
      ]);
      assert.equal(model.c.outcome, null);
    }
  }
}

export function workspaceWaitModelGate() {
  return workspaceWaitBoundaries.map(boundary => {
    const proof = new WorkspaceWaitModel(); proof.exercise(boundary);
    assertWorkspaceWaitQualification(proof); assertWorkspaceWaitBoundary(proof);
    return { boundary, phase: proof.model.phase, outcome: proof.model.c.outcome, operation: proof.operation.status,
      hardDeadline: processingWindow(proof.model.c).hardDeadline, repairUsed: processingWindow(proof.model.c).repairUsed };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(workspaceWaitModelGate(), null, 2));
