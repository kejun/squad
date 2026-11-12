import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, configuration } from './helpers.js';
import { MemoryStore, SqliteStore, TeamEngine, type Intent, type Store, type TaskContext } from '../src/index.js';
import { processingWindow, taskHumanGate, taskHumanGates, type ProcessingWindow, type HumanGate } from '../src/task/resilience.js';
import { approvalModel, hostAction } from './host-approval-model-fixture.js';

/** Real timer-routing seam with a controlled clock; no SUPERVISE event is supplied by this fixture. */
export class AutomaticWindowExpiryFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'squad-automatic-expiry-'));
  readonly store: Store;
  readonly h: Harness;
  readonly before: ProcessingWindow;
  readonly gates: HumanGate[];
  readonly usage: TaskContext['usage'];
  readonly firstSupervisions: number;
  private expirySupervisions?: number;
  constructor(storage: string, readonly problem: string) {
    assert(['Memory', 'SQLite'].includes(storage));
    assert(['目标澄清', '宿主授权', '并行宿主授权', '执行协议不兼容'].includes(problem));
    this.store = storage === 'SQLite' ? new SqliteStore(join(this.root, 'tasks.sqlite')) : new MemoryStore();
    const config = configuration({ workTimeoutMs: 1000, progressIntervalMs: 1000 });
    config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20 };
    this.h = new Harness(config, this.store);
    const owner = this.h.claim('owner');
    if (problem.includes('宿主授权')) {
      const works = [owner];
      if (problem.startsWith('并行')) {
        assert(this.h.event({ type: 'USER_INPUT', text: '请B独立核对', reviewTargets: ['B'] }).ok);
        const planner = this.h.claim('facilitator');
        assert(this.h.event({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId!,
          decision: { action: 'review', question: '核对另一来源', expected: '独立依据', reason: '用户直接要求' } }).ok);
        works.push(this.h.claim('assistance'));
      }
      works.forEach((work, index) => this.awaitApproval(work, index));
    } else assert(this.h.event({ type: 'WAIT_USER', workId: owner.id, fence: owner, question: '请选择方案甲或乙' }).ok);
    this.h.now = 50;
    if (problem === '执行协议不兼容') config.toolVersion = 'tools-unavailable';
    this.h.engine = new TeamEngine(this.store, config, () => this.h.now);
    this.h.engine.recover(this.h.room);
    this.before = structuredClone(processingWindow(this.h.context()));
    this.gates = structuredClone(taskHumanGates(this.h.context()));
    this.usage = structuredClone(this.h.context().usage);
    this.firstSupervisions = this.h.context().trace.filter(trace => trace.event === 'SUPERVISE').length;
    assert(this.gates.length > 0); assert.equal(this.before.failure, undefined);
    assert.equal(this.h.view().phase, 'waitingHuman');
    if (problem.startsWith('并行')) assert.equal(this.gates.length, 2);
  }
  private awaitApproval(work: Intent, index: number) {
    const operationId = `held-approval-${index}`, sessionId = `held-session-${index}`;
    const approval = structuredClone(approvalModel().op!.approval!); approval.id = `approval-${index}`; approval.expiresAt = 90;
    assert(this.h.event({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: 'c'.repeat(64), requestHash: String(index + 1).repeat(64),
      action: hostAction, parentAttempt: work.attempt, fence: work, workspaceId: 'project', messages: [] }).ok);
    assert(this.h.event({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, sessionId, parentAttempt: work.attempt, fence: work, leaseAvailable: true }).ok);
    assert(this.h.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId, sessionId, approval, fence: work }).ok);
  }
  advanceAndRecover() {
    let wake = this.h.engine.nextWake(this.h.room);
    assert(wake !== null && wake <= this.before.hardDeadline, 'a mandatory question must not suppress the first deadline wake');
    if (wake < this.before.hardDeadline) {
      this.h.now = wake; this.h.engine.tick(this.h.room);
      wake = this.h.engine.nextWake(this.h.room);
    }
    assert.equal(wake, this.before.hardDeadline);
    this.h.now = this.before.hardDeadline; this.h.engine.tick(this.h.room);
    this.expirySupervisions = this.h.context().trace.filter(trace => trace.event === 'SUPERVISE').length;
    assert(this.expirySupervisions <= this.firstSupervisions + 1);
    this.assertObserved();
    assert.equal(this.h.engine.nextWake(this.h.room), null, 'old work deadlines must not keep an expired human wait spinning');
    this.h.now = this.before.hardDeadline + 100;
    this.h.engine.tick(this.h.room); this.h.engine.tick(this.h.room);
    this.h.engine = new TeamEngine(this.store, this.h.config, () => this.h.now); this.h.engine.recover(this.h.room);
    this.assertObserved();
  }
  assertObserved() {
    const c = this.h.context();
    assert.deepEqual(processingWindow(c), { ...this.before, failure: { code: 'WINDOW_EXPIRED', at: this.before.hardDeadline } });
    assert.equal(this.h.view().phase, 'waitingHuman'); assert.equal(c.outcome, null);
    assert.deepEqual(taskHumanGates(c).map(g => ({ id: g.id, question: g.question, status: g.status })),
      this.gates.map(g => ({ id: g.id, question: g.question, status: g.status })));
    assert.deepEqual(c.usage, this.usage);
    assert.equal(c.trace.filter(trace => trace.event === 'WINDOW_EXPIRED').length, 1);
    assert.equal(c.trace.filter(trace => trace.event === 'SUPERVISE').length, this.expirySupervisions);
    assert(!c.resilience!.cleanup.some(item => item.state === 'pending'));
    for (const work of c.intents) for (const op of work.localOperations ?? []) {
      assert.equal(op.startedAt, undefined); assert.notEqual(op.approval?.status, 'approved');
    }
    assert.equal(this.h.engine.nextWake(this.h.room), null);
  }
  assertRenewalWake() {
    if (this.problem === '执行协议不兼容') {
      assert.equal(this.h.event({ type: 'HUMAN_GATE_DECISION', gateId: taskHumanGate(this.h.context())!.id,
        decision: 'newWindow', newWindowMs: 50, text: '只请求续窗' }).code, 'HUMAN_GATE_DECISION_NOT_ALLOWED');
      this.assertObserved(); return;
    }
    for (const gate of this.gates) assert(this.h.event({ type: 'HUMAN_GATE_DECISION', gateId: gate.id,
      decision: gate.approvalId ? 'skip' : 'reply', text: '明确处理原问题，宿主命令只跳过不批准' }).ok);
    const renewedGate = taskHumanGate(this.h.context())!; assert.equal(renewedGate.cause, 'windowExpired');
    assert(this.h.event({ type: 'HUMAN_GATE_DECISION', gateId: renewedGate.id, decision: 'newWindow', newWindowMs: 50, text: '明确授权新窗口' }).ok);
    const deadline = this.h.now + 50;
    assert.equal(processingWindow(this.h.context()).hardDeadline, deadline); assert.equal(processingWindow(this.h.context()).failure, undefined);
    const owner = this.h.claim('owner');
    assert(this.h.event({ type: 'WAIT_USER', workId: owner.id, fence: owner, question: '新窗口中的明确问题' }).ok);
    const current = taskHumanGate(this.h.context())!.id; assert.equal(this.h.engine.nextWake(this.h.room), deadline);
    this.h.now = deadline; this.h.engine.tick(this.h.room);
    assert.equal(processingWindow(this.h.context()).failure?.code, 'WINDOW_EXPIRED');
    assert.equal(taskHumanGate(this.h.context())!.id, current); assert.equal(this.h.engine.nextWake(this.h.room), null);
    assert.equal(this.h.context().trace.filter(trace => trace.event === 'WINDOW_EXPIRED').length, 2);
  }
  close() { this.store.close(); rmSync(this.root, { recursive: true, force: true }); }
}
