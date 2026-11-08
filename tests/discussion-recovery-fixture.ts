import assert from 'node:assert/strict';
import { MapReduceFixture, mapIntent } from './map-reduce-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { WorkRunner, type Intent, type TaskContext } from '../src/index.js';
import type { LocalOperation } from '../src/local-operation.js';
import type { PhysicalStage, RecoveryChange, RecoveryWork } from './map-model-gate-fixture.js';

/** Real SQLite/Engine/Runner; provider HTTP and physical-operation receipts are controlled.
 * No OS process is launched by this fixture. */
export class DiscussionRecoveryFixture extends MapReduceFixture {
  works: Intent[] = [];
  roundId = '';
  usage?: TaskContext['usage'];
  requestCount = 0;
  newRoundId = '';
  operation?: LocalOperation;

  constructor(readonly kind: RecoveryWork = '并行分片', readonly change: RecoveryChange = '修改目标') {
    super(undefined, true);
    this.response = request => {
      if (request.kind === 'interpretation' && kind === '后台讨论') {
        const ordinary = mapIntent(); delete ordinary.decomposition;
        return modelResponse({ type: 'interpretation', spec: ordinary });
      }
      if (request.kind === 'facilitator') return modelResponse({ type: 'decision', decision: {
        action: 'review', question: '核对当前目标的来源', expected: '原始依据', reason: '用户直接邀请原成员',
      } });
      return this.reply(request);
    };
  }

  async prepare() {
    await this.recognize();
    if (this.kind === '后台讨论') {
      this.claimOwner();
      assert(this.event({ type: 'USER_INPUT', text: '请两位成员讨论', reviewTargets: ['B', 'builder-1'] }).ok);
      await this.runPlanner();
    }
    this.works = this.claimMaps();
    assert.deepEqual(this.works.map(work => work.target), ['B', 'builder-1']);
    this.roundId = this.context().discussion!.id;
  }

  cancel() {
    assert(this.event(this.change === '任务结束后继续' ? { type: 'EXHAUSTED', reason: '当前轮次结束，等待用户明确继续' }
      : this.change === '停止后继续' ? { type: 'STOP' }
      : { type: 'USER_INPUT', text: '新目标', goal: { ...this.context().goal, text: '新目标' } }).ok);
    assert.equal(this.context().discussion!.status, 'cancelled');
    this.usage = structuredClone(this.context().usage);
    this.requestCount = this.requests.length;
  }

  async recoverAndInvite() {
    const outcome = this.context().outcome;
    const owners = this.context().intents.filter(work => work.kind === 'owner').map(work => work.id);
    this.reopen(); this.reopen();
    assert.deepEqual(this.context().usage, this.usage, 'Recovery must preserve charged usage');
    if (this.change === '任务结束后继续') {
      assert.equal(this.view().phase, 'ended', 'Recovery must not reactivate an ended task');
      assert.equal(this.context().outcome, outcome);
      assert.deepEqual(this.context().intents.filter(work => work.kind === 'owner').map(work => work.id), owners,
        'Recovery must not generate new owner work for an ended task');
      assert.equal(this.requests.length, this.requestCount);
    }
    if (this.change !== '修改目标') this.continueCurrentGoal();
    await this.consumeCancellations();
    assert.deepEqual(this.context().usage, this.usage, 'Cancel delivery must not charge model requests');
    assert.equal(this.requests.length, this.requestCount, 'Recovery and cancellation must not replay old provider calls');
    await this.inviteOriginalMembers();
  }

  private async inviteOriginalMembers() {
    this.claimOwner();
    assert(this.event({ type: 'USER_INPUT', text: '请原成员再讨论', reviewTargets: this.works.map(work => work.target) }).ok);
    this.newRoundId = this.context().discussion!.id;
    assert.notEqual(this.newRoundId, this.roundId);
    assert.deepEqual(this.context().discussion!.targets, ['B', 'builder-1']);
    assert.deepEqual(this.context().discussion!.skipped, []);
    await this.runPlanner();
    const members = this.pending('assistance');
    assert.deepEqual(members.map(work => work.target), ['B', 'builder-1']);
    const runner = this.runner();
    assert(await runner.runOne(this.room, this.task, members[0]!.id));
    assert(await runner.runOne(this.room, this.task, members[1]!.id));
  }

  assertMembersReturned() {
    assert.equal(this.context().discussion!.id, this.newRoundId);
    assert.deepEqual(this.context().discussion!.results.map(result => result.target), ['B', 'builder-1']);
    for (const old of this.works) {
      const stored = this.context().intents.find(work => work.id === old.id)!;
      assert(['done', 'cancelled'].includes(stored.status));
      assert.equal(stored.attempt, old.attempt, 'Old work must not get another execution attempt');
    }
    assert.equal(this.context().intents.filter(work => work.discussionId === this.roundId && work.kind === 'discussionSummary').length, 0);
  }

  assertLateResultsRejected() {
    const round = structuredClone(this.context().discussion), usage = structuredClone(this.context().usage);
    const artifacts = structuredClone(this.context().artifacts), candidate = structuredClone(this.context().candidate);
    assert.equal(this.record(this.works[0]!).ok, false);
    assert.equal(this.record(this.works[1]!).ok, false);
    assert.deepEqual(this.context().discussion, round);
    assert.deepEqual(this.context().usage, usage);
    assert.deepEqual(this.context().artifacts, artifacts);
    assert.deepEqual(this.context().candidate, candidate);
    assert.equal(this.context().intents.filter(work => work.discussionId === this.roundId && work.kind === 'discussionSummary').length, 0);
  }

  historicalPending() {
    // Compatibility input: exact persisted status shape produced by pre-KEJ-106 RECOVER.
    // This is not a production event or an alternative implementation of recovery.
    this.store.transact(this.room, tx => {
      const saved = tx.room.tasks[this.task] as { snapshot: { context: TaskContext } };
      for (const work of saved.snapshot.context.intents)
        if (this.works.some(old => old.id === work.id)) work.status = 'pending';
    });
  }

  async preparePhysical(stage: PhysicalStage) {
    await this.prepare();
    const work = this.works[0]!;
    const requested = this.engine.requestLocal(this.room, this.task, work.id, work.attempt,
      { type: 'runCli', executable: 'node', args: ['-e', 'console.log(1)'] }, [], 'workspace');
    const claim = this.engine.claimLocal(this.room, this.task, work.id, requested.id, work.attempt);
    assert(claim.response.ok && claim.operation?.sessionId);
    this.operation = claim.operation;
    if (stage !== '已领取') assert(this.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: requested.id,
      sessionId: this.operation.sessionId!, workspaceRevision: 'controlled-revision', isolated: true }).ok);
    if (stage === '已退出但效果未知') assert(this.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: requested.id,
      sessionId: this.operation.sessionId!, result: { ok: false, code: 'cancelled', data: {} }, settled: true, effectsKnown: false }).ok);
    this.assertWorkspaceAvailable(false);
  }

  async recoverPhysical() {
    this.reopen(); this.reopen();
    await this.consumeCancellations();
  }

  assertPhysicalRetained() {
    const work = this.context().intents.find(item => item.id === this.works[0]!.id)!;
    assert.equal(work.status, 'uncertain');
    assert.equal(work.localOperations!.find(op => op.id === this.operation!.id)!.status, 'uncertain');
    assert.equal(this.pending('owner').length, 0);
    assert.equal(this.pending('discussionSummary').length, 0);
    assert.equal(this.requests.length, this.requestCount);
    assert.deepEqual(this.context().usage, this.usage);
    assert.equal(this.engine.claimLocal(this.room, this.task, work.id, this.operation!.id, work.attempt).response.ok, false);
    assert.equal(this.event({ type: 'SETTLE', intentId: work.id }).code, 'LOCAL_OPERATION_PENDING');
    this.assertWorkspaceAvailable(false);
  }

  finishCurrentGoal() {
    assert(this.event({ type: 'EXHAUSTED', reason: '任务结束，保留尚未核对的效果' }).ok);
    assert.equal(this.context().goalVersion, this.works[0]!.goalVersion);
    assert.equal(this.context().epoch, this.works[0]!.epoch);
    this.usage = structuredClone(this.context().usage);
    this.requestCount = this.requests.length;
    this.reopen(); this.reopen();
  }

  reconcile() {
    const work = this.works[0]!, op = this.operation!;
    assert(['done', 'cancelled'].includes(this.context().intents.find(item => item.id === this.works[1]!.id)!.status),
      'Recovery must retire the safe member while preserving the other member’s unknown physical effect');
    const blocked = this.engine.submit(this.room, { id: `continue-before-reconcile:${this.roundId}`,
      text: '继续当前目标', intent: 'continue', replyToTaskId: this.task });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'UNRESOLVED_WORK', 'Unknown physical effects must still block public continuation');
    this.assertWorkspaceAvailable(false);
    const receipt = { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: '宿主核对的原始结果' } };
    const reply = this.event({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: op.id, sessionId: op.sessionId!,
      resolution: 'receipt', result: receipt, detail: '宿主已核对本会话的实际效果' });
    assert(reply.ok, JSON.stringify(reply));
    const current = this.context().intents.find(item => item.id === work.id)!;
    assert(['done', 'cancelled'].includes(current.status), 'Known settlement must not requeue abandoned work');
    assert.deepEqual(current.localOperations!.find(item => item.id === op.id)!.result, receipt);
  }

  assertReconciled() {
    assert.equal(this.context().discussion!.status, 'cancelled');
    assert.equal(this.pending('assistance').length, 0);
    assert.equal(this.pending('discussionSummary').length, 0);
    assert.equal(this.context().candidate, null);
    assert.deepEqual(this.context().usage, this.usage);
    assert.equal(this.requests.length, this.requestCount);
    this.assertWorkspaceAvailable(true);
  }

  async continueAfterReconcile() {
    this.continueCurrentGoal();
    await this.consumeCancellations();
    assert.deepEqual(this.context().usage, this.usage);
    assert.equal(this.requests.length, this.requestCount);
    await this.inviteOriginalMembers();
    this.assertMembersReturned();
    this.assertLateResultsRejected();
  }

  recoverWithoutMember() {
    const config = structuredClone(this.config); config.bots = config.bots.filter(bot => bot.id !== 'B');
    this.reopen(config); this.reopen(config);
  }

  async assertRemovedMemberRetired() {
    assert(this.works.every(old => ['done', 'cancelled'].includes(this.context().intents.find(work => work.id === old.id)!.status)));
    assert.equal(this.context().config.bots.some(bot => bot.id === 'B'), false);
    assert(!this.context().reason.includes('unavailable'));
    await this.consumeCancellations();
    const owner = this.pending('owner')[0]; assert(owner);
    const before = this.requests.length;
    assert(await this.runner().runOne(this.room, this.task, owner.id));
    assert.equal(this.requests.length, before + 1);
    assert.equal(this.requests.at(-1)!.kind, 'owner');
    assert.equal(this.pending('assistance').length, 0);
  }

  private runner() { return new WorkRunner(this.engine, this.adapter, () => this.now); }
  private continueCurrentGoal() {
    const reply = this.engine.submit(this.room, { id: `continue-recovered:${this.roundId}:${this.context().epoch}`,
      text: '继续当前目标', intent: 'continue', replyToTaskId: this.task });
    assert(reply.ok, `Public continuation must succeed after obsolete work retires: ${JSON.stringify(reply)}`);
  }
  private claimOwner() {
    const owner = this.pending('owner')[0]; assert(owner, 'Current owner must be available after recovery');
    assert(this.engine.claim(this.room, this.task, owner.id));
  }
  private async runPlanner() {
    const planner = this.pending('facilitator')[0]; assert(planner);
    assert(await this.runner().runOne(this.room, this.task, planner.id));
  }
  private async consumeCancellations() {
    const requests = this.requests.length;
    const runner = this.runner();
    for (let remaining = 12; remaining > 0; remaining--) {
      const cancel = this.pending('cancel')[0];
      if (!cancel) { assert.equal(this.requests.length, requests); return; }
      assert(await runner.runOne(this.room, this.task, cancel.id), JSON.stringify({ phase: this.view().phase,
        reply: this.context().reply, cancellationId: cancel.id }));
    }
    assert.fail('Cancellation delivery did not settle within its bounded steps');
  }
  private assertWorkspaceAvailable(expected: boolean) {
    const available = this.store.transact(this.room, tx => {
      const acquired = tx.acquireWorkspace('workspace', 'recovery-probe');
      if (acquired) tx.releaseWorkspace('workspace', 'recovery-probe');
      return acquired;
    });
    assert.equal(available, expected, 'Persistent workspace lease must follow known physical settlement');
  }
}
