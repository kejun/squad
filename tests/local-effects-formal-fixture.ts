import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { MemoryStore, SqliteStore } from '../src/store.js';
import { CliJournal } from '../src/local-cli.js';
import { initialTask, stepTask } from '../src/task.machine.js';
import type { Intent, TaskEvent, TaskInput, TeamConfig } from '../src/types.js';

const config: TeamConfig = {
  version: 'team-v3', toolVersion: 'tools-v3', defaultBot: 'A', localTools: { enabled: true }, inputAnalysis: { enabled: false },
  bots: [{ id: 'A', name: 'A', instructions: '', tools: [] }],
  limits: { ordinary: 50, checks: 5, assists: 5, retries: 5, replans: 5, workTimeoutMs: 1000, progressIntervalMs: 1000, repeatThreshold: 3 },
};
const result = { ok: true, code: 'succeeded', data: { stdout: 'original-result', exitCode: 0 } };
const pendingStates = new Set(['claimed', 'running', 'cancelling', 'uncertain']);

/** Real XState gate, independent of storage, journal and external execution. */
export function localEffectsModelGate() {
  const input: TaskInput = { taskId: 'gate', owner: 'A', at: 0, config,
    goal: { text: '核对命令', constraints: [], criteria: ['保留原回执'], requiredArtifacts: 0 },
    message: { id: 'gate', taskId: 'gate', author: 'user', kind: 'user', text: '核对命令', at: 0 } };
  let snapshot = initialTask(input), sequence = 0;
  const send = (body: object) => { snapshot = stepTask(snapshot, { ...body, id: `gate:${++sequence}`, at: 1 } as TaskEvent); assert(snapshot.context.reply.ok); };
  const work = snapshot.context.intents[0]!;
  send({ type: 'CLAIM', intentId: work.id });
  send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'op', parentAttempt: 1, namespace: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: [] }, workspaceId: 'shared', messages: [], fence: work });
  send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'op', parentAttempt: 1, sessionId: 'session', leaseAvailable: true, fence: work });
  send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'op', sessionId: 'session', result, settled: false, effectsKnown: false });
  assert.equal(snapshot.context.intents[0]!.localOperations![0]!.status, 'uncertain');
  assert.equal(snapshot.context.intents[0]!.localCheckpoint!.pendingOperationId, 'op');
  send({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: 'op', sessionId: 'session', resolution: 'receipt', detail: 'trusted', result });
  assert.equal(snapshot.context.intents[0]!.localCheckpoint!.pendingOperationId, undefined);
  assert.equal(snapshot.context.intents[0]!.localCheckpoint!.messages.length, 1);
  return { model: 'taskMachine', status: 'passed' };
}

/** Environment writes are synthetic trusted host observations; no CLI or model is executed here. */
export class LocalEffectsFixture {
  root = ''; store!: MemoryStore | SqliteStore; engine!: TeamEngine; journal!: CliJournal;
  work!: Intent; contender!: Intent; operationId = ''; competitorId = ''; sessionId = '';
  online = true; crashed = false; rolledBack = false; starts = 0; competitor = false;
  badSession = false; falseNotStarted = false;
  private sequence = 0;
  private lastCommit: TaskEvent | undefined;
  private leaseOwner: string | undefined;
  private contenderLeaseOwner: string | undefined;
  private journalStage = 1;
  constructor(readonly backend: 'memory' | 'sqlite' = 'memory') {}
  async open(prepared = true) {
    this.root = await mkdtemp(join(tmpdir(), 'squad-local-formal-'));
    this.store = this.backend === 'sqlite' ? new SqliteStore(join(this.root, 'state.sqlite')) : new MemoryStore();
    this.engine = new TeamEngine(this.store, config, () => 1);
    this.journal = new CliJournal(join(this.root, 'journal'));
    this.work = this.create('original'); this.contender = this.create('contender');
    this.operationId = this.engine.requestLocal('original', 'task:start', this.work.id, this.work.attempt,
      { type: 'runCli', executable: 'node', args: ['effect.js'] }, [], 'shared-workspace').id;
    this.competitorId = this.engine.requestLocal('contender', 'task:start', this.contender.id, this.contender.attempt,
      { type: 'runCli', executable: 'node', args: ['other.js'] }, [], 'shared-workspace').id;
    const claimed = this.engine.claimLocal('original', 'task:start', this.work.id, this.operationId, this.work.attempt);
    assert(claimed.response.ok); this.sessionId = claimed.operation!.sessionId!;
    this.leaseOwner = this.leaseIdentity('original', 'task:start', this.operationId);
    assert.equal(this.readLease(), this.leaseOwner);
    if (prepared) await this.journal.write({ operationId: this.operationId, sessionId: this.sessionId, phase: 'prepared' });
    else this.journalStage = 0;
    return this;
  }
  private create(room: string) {
    assert(this.engine.submit(room, { id: 'start', text: '核对原命令' }).ok);
    const work = this.engine.claim(room, 'task:start', this.engine.pending(room, 'task:start')[0]!.id)!;
    assert(work); assert(this.engine.beginExecution(room, 'task:start', work)); return work;
  }
  context() { return this.engine.view('original', 'task:start')!.context; }
  original() { return this.context().intents.find(work => work.id === this.work.id)!; }
  operation() { return this.original().localOperations!.find(op => op.id === this.operationId)!; }
  send(body: object) { return this.engine.send('original', 'task:start', { ...body, id: `local-formal:${++this.sequence}`, at: 1 } as TaskEvent); }
  private readLease() {
    let owner: string | undefined;
    this.store.transact('lease-observer', tx => {
      for (const candidate of ['probe', this.leaseOwner, this.contenderLeaseOwner].filter((value): value is string => !!value)) {
        if (tx.acquireWorkspace('shared-workspace', candidate)) {
          if (candidate === 'probe') tx.releaseWorkspace('shared-workspace', candidate);
          else owner = candidate;
          break;
        }
      }
    });
    return owner;
  }
  async state() {
    const operation = this.operation(), cp = this.original().localCheckpoint!;
    const journal = await this.journal.read(this.sessionId);
    assert.equal(journal?.phase, this.journalStage === 2 ? 'settled' : this.journalStage === 1 ? 'prepared' : undefined);
    const owner = this.readLease();
    return { op: ({ claimed: 1, running: 2, uncertain: 3, succeeded: 4, cancelling: 6, queued: 0, cancelled: 5 } as Record<string, number>)[operation.status],
      journal: this.journalStage, online: this.online, crashed: this.crashed, rolledBack: this.rolledBack, stopped: this.context().stopped,
      lease: owner === this.leaseOwner ? 1 : owner === this.contenderLeaseOwner && owner ? 2 : 0,
      pending: cp.pendingOperationId === this.operationId,
      receipts: cp.messages.filter(message => message.content.includes('"type":"local_tool_result"')).length,
      starts: this.starts, competitor: this.competitor, badSession: this.badSession, falseNotStarted: this.falseNotStarted };
  }
  private identity() { return { intentId: this.work.id, operationId: this.operationId, sessionId: this.operation().sessionId! }; }
  async receipt() {
    const reconciled = await this.journal.reconcile(this.operationId, this.sessionId);
    assert(reconciled?.resolution === 'receipt' && reconciled.result, 'LocalEffects:KnownReceipt');
    return { ...this.identity(), ...reconciled };
  }
  async apply(action: string) {
    switch (action) {
      case 'Start': assert(this.send({ type: 'LOCAL_STARTED', ...this.identity() }).ok); this.starts++; break;
      case 'SaveReceipt': await this.journal.write({ operationId: this.operationId, sessionId: this.sessionId, phase: 'settled', completion: { result, settled: true, effectsKnown: true } }); this.journalStage = 2; break;
      case 'UnknownResult': assert(this.send({ type: 'LOCAL_RESULT', ...this.identity(), result, settled: false, effectsKnown: false }).ok); break;
      case 'Stop': assert(this.send({ type: 'STOP' }).ok); break;
      case 'Crash': this.online = false; this.crashed = true; break;
      case 'Reopen': this.reopen(); break;
      case 'Commit': await this.commit(); break;
      case 'Rollback': {
        const before = this.store.read('original'), beforeLease = this.readLease(); this.store.failNextCommit = true;
        await assert.rejects(this.commit(), /Injected commit failure/, 'LocalEffects:RollbackMustFail');
        assert.deepEqual(this.store.read('original'), before, 'LocalEffects:RollbackSnapshot');
        assert.equal(this.readLease(), beforeLease, 'LocalEffects:RollbackLease');
        this.online = false; this.rolledBack = true; break;
      }
      case 'UnknownProbe': {
        const classification = await this.journal.reconcile(this.operationId, this.sessionId);
        this.falseNotStarted = classification?.resolution === 'notStarted';
        assert.equal(classification, null, 'LocalEffects:NoFalseNotStarted');
        assert.equal(this.engine.claimLocal('original', 'task:start', this.work.id, this.operationId, this.work.attempt).response.ok, false, 'LocalEffects:UnknownClaimDenied'); break;
      }
      case 'WrongSession':
        this.badSession = this.send({ type: 'LOCAL_RESULT', ...this.identity(), sessionId: 'wrong-session', result, settled: true, effectsKnown: true }).ok;
        assert.equal(this.badSession, false, 'LocalEffects:SessionBound'); break;
      case 'Duplicate': assert(this.lastCommit); assert(this.engine.send('original', 'task:start', this.lastCommit).duplicate, 'LocalEffects:DuplicateReceipt'); break;
      case 'BusyProbe': assert.equal(this.engine.claimLocal('contender', 'task:start', this.contender.id, this.competitorId, this.contender.attempt).response.code, 'WORKSPACE_BUSY', 'LocalEffects:LeaseExclusive'); break;
      case 'Compete': {
        const claim = this.engine.claimLocal('contender', 'task:start', this.contender.id, this.competitorId, this.contender.attempt);
        assert(claim.response.ok, 'LocalEffects:CompetitorCanProceed'); this.competitor = true;
        this.contenderLeaseOwner = this.leaseIdentity('contender', 'task:start', this.competitorId); break;
      }
      default: throw new Error(`Unknown local-effects action: ${action}`);
    }
    this.assertProperties(await this.state());
  }
  private leaseIdentity(roomId: string, taskId: string, operationId: string) {
    // Observer key uses exactly the public store's opaque owner identity, not a forged lease write.
    return createHash('sha256').update(JSON.stringify({ operationId, roomId, taskId })).digest('hex');
  }
  async commit() {
    const body = await this.receipt();
    const type = this.operation().status === 'uncertain' ? 'LOCAL_RECONCILE' : 'LOCAL_RESULT';
    const event = { ...body, type, ...(type === 'LOCAL_RESULT' ? { settled: true, effectsKnown: true } : {}), id: `commit:${++this.sequence}`, at: 1 } as TaskEvent;
    const reply = this.engine.send('original', 'task:start', event);
    assert(reply.ok, `LocalEffects:Commit:${reply.code}`); this.lastCommit = event;
  }
  reopen() {
    const context = this.context();
    assert.equal(Object.keys(this.store.read('original').tasks).length, 1, 'LocalEffects:SliceOneOriginalTask');
    assert.equal(context.results.length, 0, 'LocalEffects:SliceNoHandoffFlush');
    assert.equal(context.assists.length, 0, 'LocalEffects:SliceNoAssistance');
    assert.equal(context.discussion, undefined, 'LocalEffects:SliceNoDiscussion');
    assert.equal(context.hostRetryBatch, undefined, 'LocalEffects:SliceNoRetryBatch');
    assert.equal(context.hostRetryRequests?.length ?? 0, 0, 'LocalEffects:SliceNoRetryRequests');
    assert(context.nextCheckAt > 1, 'LocalEffects:SliceTickNotDue');
    assert(context.intents.every(work => work.deadline === null || work.deadline > 1), 'LocalEffects:SliceNoWorkExpiry');
    if (this.backend === 'sqlite') { this.store.close(); this.store = new SqliteStore(join(this.root, 'state.sqlite')); }
    this.engine = new TeamEngine(this.store, config, () => 1); this.online = true; this.engine.recover('original');
  }
  assertProperties(state: Awaited<ReturnType<LocalEffectsFixture['state']>>) {
    if (pendingStates.has(this.operation().status)) assert.equal(state.lease, 1, 'LocalEffects:UnconfirmedKeepsLease');
    assert.equal(state.op === 4, !state.pending && state.receipts === 1, 'LocalEffects:AtomicCheckpoint');
    if (state.competitor) assert.equal(state.op, 4, 'LocalEffects:CompetitorAfterSettlement');
    assert(state.starts <= 1, 'LocalEffects:OneStart');
    assert.equal(state.badSession, false, 'LocalEffects:SessionBound');
    assert.equal(state.falseNotStarted, false, 'LocalEffects:NoFalseNotStarted');
    if (state.stopped) assert.equal(this.context().candidate, null, 'LocalEffects:StoppedNoPublication');
  }
  async close() { this.store.close(); await rm(this.root, { recursive: true, force: true }); }
}
