import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { withFixtureAcceptance } from './delivery-protocol-fixture.js';
import { runProcess } from '../src/local-cli.js';
import { MemoryStore, SqliteStore, type Store } from '../src/store.js';
import { unconfinedEffectsKey, type ResourceLease } from '../src/local-resource-policy.js';
import type { LocalAction, LocalOperation } from '../src/local-operation.js';
import type { Intent, TaskEvent } from '../src/types.js';
import type { RoomSnapshot, WebBlocker, WebRoom } from '../src/web/contracts.js';

interface OldExecution {
  room: WebRoom; taskId: string; work: Intent; op: LocalOperation;
  execution: Awaited<ReturnType<HostApprovalFixture['runtime']['execute']>>;
}
type SourceBlocker = WebBlocker & { source?: { roomId: string; roomTitle: string } };

/** Real child processes, adapter, runner, HTTP and SQLite. The explicitly
 * injected process backend controls the unknown-effects boundary; no OS
 * confinement claim is made by this integration fixture. */
export class WorkspaceWaitAcceptance {
  readonly fixture = new HostApprovalFixture();
  readonly old: OldExecution[] = [];
  readonly oldStarts: string[] = [];
  readonly waiting = new Map<string, number>();
  private sequence = 0;
  snapshot!: RoomSnapshot;
  result?: Record<string, unknown>;

  async open(count = 2) {
    this.fixture.sandboxBackend = { available: true, isolation: 'workspace', execute: async (input, signal, onSpawn) => {
      this.oldStarts.push(input.sessionId);
      return { ...await runProcess(input, signal, onSpawn), effectsKnown: false };
    } };
    await this.fixture.open();
    this.fixture.service.config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 60_000, cancelGraceMs: 10 };
    const runtime = this.fixture.runtime, wait = runtime.waitForWorkspace.bind(runtime);
    runtime.waitForWorkspace = (key, generation, signal) => {
      this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
      return wait(key, generation, signal).finally(() => this.waiting.set(key, (this.waiting.get(key) ?? 1) - 1));
    };
    for (let index = 0; index < count; index++) this.old.push(await this.prepareOld(index));
    return this;
  }

  private event(roomId: string, taskId: string, event: Record<string, unknown>) {
    const response = this.fixture.service.engine.send(roomId, taskId,
      { id: `workspace-service:${++this.sequence}`, at: Date.now(), ...event } as TaskEvent);
    assert(response.ok, JSON.stringify(response)); return response;
  }

  private async prepareOld(index: number): Promise<OldExecution> {
    const { service, runtime } = this.fixture, engine = service.engine;
    const room = service.createRoom(`旧未决会话 ${index + 1}`);
    const taskId = engine.submit(room.id, { id: randomUUID(), text: '保留可核对的旧任务执行' }).taskId!;
    const owner = engine.claim(room.id, taskId, engine.pending(room.id, taskId)[0]!.id)!; assert(owner);
    this.event(room.id, taskId, { type: 'USER_INPUT', text: '请核查员独立核对', reviewTargets: ['B'] });
    const planner = engine.claim(room.id, taskId, engine.pending(room.id, taskId).find(work => work.kind === 'facilitator')!.id)!;
    this.event(room.id, taskId, { type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, attempt: planner.attempt,
      discussionId: planner.discussionId, decision: { action: 'review', question: '核对旧独立来源', expected: '真实进程回执', reason: '明确用户前缀' } });
    const work = engine.claim(room.id, taskId, engine.pending(room.id, taskId).find(work => work.kind === 'assistance')!.id)!;
    const action: LocalAction = { type: 'runCli', executable: process.execPath, args: ['-e', `console.log("old-process-${index + 1}")`] };
    const namespace = engine.localNamespace(room.id, taskId);
    const op = engine.requestLocal(room.id, taskId, work.id, work.attempt, action, [], runtime.workspaceId(work, namespace), runtime.resourcePolicy(work, action, namespace));
    const claimed = engine.claimLocal(room.id, taskId, work.id, op.id, work.attempt); assert(claimed.response.ok);
    const execution = await runtime.execute(work, claimed.operation!, new AbortController().signal,
      metadata => this.event(room.id, taskId, { type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: claimed.operation!.sessionId, ...metadata }),
      undefined, { roomId: room.id, taskId }, metadata => this.event(room.id, taskId, {
        type: 'LOCAL_PREPARED', intentId: work.id, operationId: op.id, sessionId: claimed.operation!.sessionId, fence: work, ...metadata,
      }));
    assert(execution.settled); assert.equal(execution.effectsKnown, false); assert(execution.result.ok);
    this.event(room.id, taskId, { type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: claimed.operation!.sessionId, ...execution });
    this.event(room.id, taskId, { type: 'STOP' });
    const saved = engine.view(room.id, taskId)!.context.intents.find(item => item.id === work.id)!.localOperations!.find(item => item.id === op.id)!;
    assert.equal(saved.status, 'uncertain');
    if (index === 0) service.setRoomArchived(room.id, randomUUID(), true);
    return { room, taskId, work, op: saved, execution };
  }

  private currentOperation() { return this.fixture.operation(); }
  private sources(snapshot = this.snapshot) { return (snapshot.blockers ?? []).filter(blocker => (blocker as SourceBlocker).source) as SourceBlocker[]; }
  private async readSnapshot() {
    const response = await fetch(this.fixture.url + this.fixture.route()); assert.equal(response.status, 200);
    this.snapshot = await response.json() as RoomSnapshot; return this.snapshot;
  }

  async wait() {
    assert(this.fixture.submit().ok);
    await hostUntil(() => this.currentOperation(), op => op?.status === 'queued');
    await hostUntil(() => this.waiting.get('resources') ?? 0, count => count === 1);
    await this.readSnapshot();
    assert.equal(this.currentOperation()!.startedAt, undefined);
    assert.equal(await this.fixture.runs(), '');
  }

  async verifySources() {
    await this.readSnapshot();
    assert.equal(this.snapshot.tasks.at(-1)!.supervision?.status, 'waitingResources');
    assert.deepEqual(this.sources().map(blocker => blocker.source!.roomId).sort(), this.old.map(item => item.room.id).sort(),
      'The current room must identify both actual old resource owners, including the archived room');
    for (const old of this.old) {
      const blocker = this.sources().find(item => item.source!.roomId === old.room.id)!;
      assert.equal(blocker.source!.roomTitle, old.room.title); assert.equal(blocker.taskId, old.taskId);
      assert.equal(blocker.scope, 'cleanup'); assert.equal(blocker.operation?.workId, old.work.id);
      assert.equal(blocker.operation?.operationId, old.op.id); assert.equal(blocker.operation?.approvalId, undefined);
      assert.equal(blocker.status, 'open'); assert.equal(blocker.actions.length, 0);
    }
    assert.equal(this.snapshot.hostApprovals?.length ?? 0, 0, 'A queued operation has not yet created a host approval');
    assert.equal(this.currentOperation()!.status, 'queued'); assert.equal(this.currentOperation()!.startedAt, undefined);
    assert.equal(await this.fixture.runs(), '');
  }

  async confirmOld(old: OldExecution) {
    const route = `/api/rooms/${old.room.id}`;
    const query = new URLSearchParams({ taskId: old.taskId, workId: old.work.id, operationId: old.op.id });
    const response = await fetch(this.fixture.url + route + '/operation-review?' + query);
    assert.equal(response.status, 200, await response.clone().text());
    const review = await response.json() as { processState: string; reviewDigest: string; operationId: string; sessionId: string };
    assert.equal(review.processState, 'exited'); assert.equal(review.operationId, old.op.id); assert.equal(review.sessionId, old.op.sessionId);
    const confirmation = await fetch(this.fixture.url + route + '/operation-reconcile', { method: 'POST',
      headers: { origin: this.fixture.url, 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), taskId: old.taskId, workId: old.work.id, operationId: old.op.id, reviewDigest: review.reviewDigest }) });
    assert.equal(confirmation.status, 200, await confirmation.text());
  }

  async verifyPartialSettlement() {
    assert.equal(this.old.length, 2);
    await this.confirmOld(this.old[0]!);
    await hostUntil(() => this.fixture.service.engine.view(this.old[0]!.room.id, this.old[0]!.taskId)!.context.intents
      .find(work => work.id === this.old[0]!.work.id)!.localOperations!.find(op => op.id === this.old[0]!.op.id)!.status, status => status !== 'uncertain');
    await this.readSnapshot();
    assert.deepEqual(this.sources().map(blocker => blocker.source!.roomId), [this.old[1]!.room.id]);
    assert.equal(this.currentOperation()!.status, 'queued'); assert.equal(this.currentOperation()!.startedAt, undefined);
    assert.equal(this.snapshot.hostApprovals?.length ?? 0, 0); assert.equal(await this.fixture.runs(), '');
    assert.equal(this.oldStarts.length, 2, 'Settling one old effect must not replay either old command');
    const cancelled = this.currentOperation()!;
    const before = this.fixture.service.engine.view(this.fixture.room.id, this.fixture.taskId)!.context;
    this.fixture.beforeOwnerResponse = async request => modelResponse(withFixtureAcceptance({ type: 'answer', text: '已按新目标提供纯文字说明。' }, request));
    this.event(this.fixture.room.id, this.fixture.taskId, { type: 'USER_INPUT', text: '改为仅提供纯文字说明，不执行命令',
      goal: { text: '仅提供纯文字说明', constraints: [], criteria: [], requiredArtifacts: 0 } });
    await this.readSnapshot();
    const after = this.fixture.service.engine.view(this.fixture.room.id, this.fixture.taskId)!.context;
    assert(after.goalVersion > before.goalVersion);
    assert.equal(after.intents.flatMap(work => work.localOperations ?? []).find(op => op.id === cancelled.id)!.status, 'cancelled');
    assert.equal(this.sources().length, 0, 'An unrelated replacement goal must not inherit the cancelled command resource dependency');
    const remaining = this.old[1]!;
    const oldContext = this.fixture.service.engine.view(remaining.room.id, remaining.taskId)!.context;
    assert.equal(oldContext.intents.find(work => work.id === remaining.work.id)!.localOperations!.find(op => op.id === remaining.op.id)!.status, 'uncertain');
    const observer = new SqliteStore(join(this.fixture.root, 'team.sqlite'));
    try {
      assert.equal(observer.resourceBlockers(cancelled.workspaceId!, 'fresh-resource-observer', cancelled.resourceLeases).length, 1,
        'Changing the new goal must not release the old operation resource lease');
    } finally { observer.close(); }
    assert.equal(await this.fixture.runs(), ''); assert.equal(this.oldStarts.length, 2);
    this.result = { remainingSources: 1, processStarts: 0, oldProcessStarts: 2, staleDependencyRemoved: true, oldLeasePreserved: true };
  }

  async settleLast(mode: string) {
    assert.equal(this.old.length, 1); const old = this.old[0]!;
    assert.equal(this.waiting.get('resources'), 1, 'An actual typed-resource waiter must exist before settlement');
    if (mode === '人类执行核对') await this.confirmOld(old);
    else {
      assert(['后台回执恢复', '归档强制删除'].includes(mode));
      if (mode === '归档强制删除') {
        const reconcile = this.fixture.runtime.reconcile.bind(this.fixture.runtime);
        this.fixture.runtime.reconcile = async op => {
          // Keep periodic reconciliation from releasing the lease before
          // explicit deletion commits its own resource removal.
          if (op.id === old.op.id && !this.fixture.service.engine.roomDeletion(old.room.id)?.context.deletionId) return null;
          return reconcile(op);
        };
      }
      if (mode === '归档强制删除') {
        const sourceRoom = this.fixture.service.snapshot(old.room.id).room; assert.equal(sourceRoom.archived, true);
        const deletion = await fetch(this.fixture.url + `/api/rooms/${old.room.id}/delete`, { method: 'POST',
          headers: { origin: this.fixture.url, 'content-type': 'application/json' },
          body: JSON.stringify({ id: randomUUID(), expectedArchiveVersion: sourceRoom.archiveVersion }) });
        assert.equal(deletion.status, 202, await deletion.text());
        await hostUntil(async () => (await fetch(this.fixture.url + `/api/rooms/${old.room.id}`)).status, status => status === 410);
        assert(this.fixture.service.deletedRooms().some(room => room.roomId === old.room.id));
        const deletionState = this.fixture.service.engine.roomDeletion(old.room.id)!.context;
        assert.equal(deletionState.force, true); assert.equal(deletionState.dataErased, true);
        const observer = new SqliteStore(join(this.fixture.root, 'team.sqlite'));
        try { assert.equal(observer.verifyDeletionDataGone(old.room.id), true,
          'Explicit deletion must erase the old room and release its actual resource leases'); }
        finally { observer.close(); }
      } else {
        // Only the durable journal changes. The production cleanup scheduler
        // must read this trusted receipt and commit LOCAL_RECONCILE itself.
        await this.fixture.runtime.journal.write({ operationId: old.op.id, sessionId: old.op.sessionId!, phase: 'settled',
          completion: { ...old.execution, effectsKnown: true } });
      }
    }
    const approval = await this.fixture.approval();
    assert.equal(approval.taskId, this.fixture.taskId); assert.notEqual(approval.operationId, old.op.id);
    assert.equal(this.currentOperation()!.status, 'awaitingApproval'); assert.equal(this.currentOperation()!.startedAt, undefined);
    assert.equal(await this.fixture.runs(), ''); assert.equal(this.oldStarts.length, 1);
    await this.readSnapshot(); assert.equal(this.sources().length, 0);
    const accepted = await this.fixture.request(this.fixture.decisionData(approval, 'approve'));
    assert.equal(accepted.status, 200); await this.fixture.assertSuccessfulRun();
    assert.equal(this.oldStarts.length, 1, 'The old completed process must never be replayed');
    this.result = { mode, currentApprovalVisible: true, approvedStarts: 1, oldProcessStarts: 1, originalTypedWaiterWoken: true,
      ...(mode === '归档强制删除' ? { sourceDeleted: true } : {}) };
  }

  async close() { await this.fixture.close(); }
}

/** Public store transactions check the compatibility cases that a host writer
 * cannot distinguish: every global reader legitimately blocks such a writer. */
export async function workspaceWaitConflictMatrix() {
  const root = await mkdtemp(join(tmpdir(), 'squad-wait-index-')); await mkdir(join(root, 'db'));
  const stores: Store[] = [new MemoryStore(), new SqliteStore(join(root, 'db/team.sqlite'))];
  const read: ResourceLease[] = [{ key: 'shared', mode: 'read', phase: 'execute' }];
  const write: ResourceLease[] = [{ key: 'shared', mode: 'write', phase: 'execute' }];
  try {
    for (const store of stores) {
      store.transact('a', tx => { assert(tx.acquireResources!(read, 'reader-a')); });
      store.transact('b', tx => { assert(tx.acquireResources!(read, 'reader-b')); });
      const observe = store as Store & { resourceBlockers(workspaceId: string, owner: string, requests?: ResourceLease[]): string[] };
      assert.deepEqual(observe.resourceBlockers('shared', 'requester', read), [], 'Compatible reads must not be projected as blockers');
      assert.deepEqual(observe.resourceBlockers('shared', 'requester', write).sort(), ['reader-a', 'reader-b']);
      assert.deepEqual(observe.resourceBlockers('unrelated', 'requester', [{ key: 'unrelated', mode: 'write', phase: 'execute' }]), []);
      store.transact('b', tx => { tx.releaseResources!(['shared'], 'reader-b'); });
      assert.deepEqual(observe.resourceBlockers('shared', 'requester', write), ['reader-a'], 'Settled owners must disappear');
      store.transact('a', tx => { tx.releaseResources!(['shared'], 'reader-a'); assert(tx.acquireWorkspace('legacy', 'legacy-owner')); });
      assert.deepEqual(observe.resourceBlockers('legacy', 'requester'), ['legacy-owner']);
      assert.deepEqual(observe.resourceBlockers('unrelated', 'requester'), []);
      assert.deepEqual(observe.resourceBlockers('global', 'requester', [{ key: unconfinedEffectsKey, mode: 'write', phase: 'execute' }]), ['legacy-owner']);
    }
    return { stores: ['MemoryStore', 'SqliteStore'], compatibleReadsExcluded: true, unrelatedExcluded: true, settledExcluded: true, legacyBarrierVisible: true };
  } finally { stores.forEach(store => store.close()); await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'projection';
  const scenario = await new WorkspaceWaitAcceptance().open(mode === 'projection' ? 2 : 1);
  try {
    await scenario.wait();
    if (mode === 'projection') { await scenario.verifySources(); await workspaceWaitConflictMatrix(); await scenario.verifyPartialSettlement(); }
    else await scenario.settleLast(mode === 'human' ? '人类执行核对' : mode === 'deletion' ? '归档强制删除' : '后台回执恢复');
    console.log(JSON.stringify({ mode, result: scenario.result }));
  } finally { await scenario.close(); }
}
