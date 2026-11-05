import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { MemoryStore, SqliteStore } from '../src/store.js';
import { WorkRunner, WorkFailure } from '../src/runner.js';
import type { Intent } from '../src/types.js';
import { localModelInput } from './local-model-fixture.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';

export class ActorIntegration {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-actor-integration-'));
  readonly room = 'actors'; readonly task = 'task:first';
  readonly config = localModelInput().config;
  store: MemoryStore | SqliteStore;
  engine: TeamEngine;
  calls: Intent[] = [];
  attempts = 0;
  constructor(readonly backend: string) {
    assert(['Memory', 'SQLite'].includes(backend)); this.store = this.open(); this.engine = this.host();
    assert(this.engine.submit(this.room, { id: 'first', text: '形成核查方案' }).ok);
  }
  private open() { return this.backend === 'SQLite' ? new SqliteStore(join(this.directory, 'team.sqlite')) : new MemoryStore(); }
  private host() { return new TeamEngine(this.store, this.config, () => 30); }
  reopen() {
    if (this.backend === 'SQLite') { this.store.close(); this.store = this.open(); }
    this.engine = this.host(); this.engine.recover(this.room);
  }
  context() { return this.engine.view(this.room, this.task)!.context; }
  claim() { const work = this.engine.claim(this.room, this.task, this.engine.pending(this.room, this.task)[0]!.id); assert(work); return work; }
  runner(failOnce = true) {
    return new WorkRunner(this.engine, { execute: async work => {
      assert.equal(this.engine.executionPhase(this.room, this.task, work), 'running');
      assert.equal(this.context().intents.find(intent => intent.id === work.id)!.status, 'inflight');
      this.calls.push(structuredClone(work));
      if (work.kind === 'assistance') {
        this.attempts++; if (failOnce && this.attempts === 1) throw new WorkFailure('可恢复故障', true);
        return { type: 'answer', text: '核查结论' };
      }
      if (work.kind === 'check') return fixtureCheck(work.payload.candidate);
      if (!work.payload.resultId) return { type: 'help', requestId: 'H', target: 'B', question: '核查', expected: '依据' };
      return { type: 'deliver', text: '完成方案', artifactIds: [] };
    } }, () => 30);
  }
  async complete() {
    const runner = this.runner();
    for (let n = 0; n < 15; n++) if (!await runner.runOne(this.room, this.task)) break;
    const c = this.context(); assert.equal(c.outcome, 'complete'); assert.equal(this.calls.length, 5);
    assert.equal(c.usage.ordinary, 4); assert.equal(c.usage.checks, 1); assert.equal(c.usage.retries, 1);
    const help = c.results[0]!; assert(help.consumed); assert.equal(c.messages.filter(message => message.kind === 'answer' && message.requestId === 'H').length, 1);
    assert.equal(c.intents.filter(intent => intent.payload.resultId === help.resultId).length, 1);
    for (const work of this.calls) assert(['settled', 'interrupted'].includes(this.engine.executionPhase(this.room, this.task, work) as string));
    assert.equal(this.engine.send(this.room, this.task, { type: 'EXECUTION_START', intentId: this.calls[0]!.id, attempt: 1, id: 'forged', at: 30 }).code, 'HOST_ONLY_EVENT');
    this.reopen(); assert.equal(await this.runner().runOne(this.room, this.task), false); assert.equal(this.calls.length, 5);
  }
  reserved: Intent | undefined;
  reserve() { this.reserved = this.claim(); assert.equal(this.engine.executionPhase(this.room, this.task, this.reserved), 'authorized'); }
  failPermit() {
    assert(this.reserved); const before = this.store.read(this.room); this.store.failNextCommit = true;
    assert.throws(() => this.engine.beginExecution(this.room, this.task, this.reserved!), /Injected commit failure/);
    assert.deepEqual(this.store.read(this.room), before); assert.equal(this.calls.length, 0);
    assert.equal(this.engine.executionPhase(this.room, this.task, this.reserved), 'authorized');
  }
  async recoverPermit() {
    const old = this.reserved!; this.reopen(); assert(!this.engine.beginExecution(this.room, this.task, old));
    assert(await this.runner(false).runOne(this.room, this.task));
    const next = this.calls[0]!; assert.equal(next.id, old.id); assert.equal(next.attempt, old.attempt + 1);
    assert(!this.engine.beginExecution(this.room, this.task, next));
    assert.equal(this.engine.executionPhase(this.room, this.task, old), 'interrupted');
    assert.equal(this.engine.executionPhase(this.room, this.task, next), 'settled'); assert.equal(this.calls.length, 1);
  }
  close() { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
}

/** A provider outlives safe recovery; its late completion must not retire the next attempt. */
export class LateAttemptRace {
  readonly test: ActorIntegration;
  readonly runner: WorkRunner;
  readonly calls: Intent[] = [];
  readonly first: Promise<boolean>;
  readonly next: Promise<boolean>;
  private releaseOld: (() => void) | undefined;
  private oldExtra: ((id: string) => void) | undefined;
  private currentSignal: AbortSignal | undefined;
  constructor(backend = 'Memory') {
    this.test = new ActorIntegration(backend);
    const { test } = this;
    this.runner = new WorkRunner(test.engine, { execute: async (work, signal, scope) => {
      assert.equal(test.engine.executionPhase(test.room, test.task, work), 'running'); this.calls.push(work);
      if (work.attempt === 1) {
        this.oldExtra = scope.authorizeAdditionalRequest;
        await new Promise<void>(resolve => { this.releaseOld = resolve; });
        return { type: 'deliver', text: '不得发布的旧结果', artifactIds: [] };
      }
      this.currentSignal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new WorkFailure('cancelled')), { once: true }));
      assert.fail('The current provider must terminate through cancellation');
    } }, () => 30);
    this.first = this.runner.runOne(test.room, test.task); assert.equal(this.calls.length, 1);
    test.engine.recover(test.room);
    this.next = this.runner.runOne(test.room, test.task); assert.equal(this.calls.length, 2); assert(this.currentSignal);
  }
  async finish() {
    const { test, calls, runner } = this, budget = structuredClone(test.context().usage);
    assert.throws(() => this.oldExtra!('late-extra-request'), /STALE_ATTEMPT/); assert.deepEqual(test.context().usage, budget);
    this.releaseOld!(); await this.first;
    assert.equal(test.engine.executionPhase(test.room, test.task, calls[1]!), 'running'); assert.equal(test.context().candidate, null);
    assert(test.engine.send(test.room, test.task, { type: 'STOP', id: 'stop-current', at: 30 }).ok);
    assert(await runner.runOne(test.room, test.task)); assert(this.currentSignal!.aborted); await this.next;
    assert.equal(test.context().outcome, 'stopped'); assert.equal(test.context().candidate, null);
    assert(!test.context().messages.some(message => message.text.includes('不得发布')));
    assert.equal(test.engine.executionPhase(test.room, test.task, calls[0]!), 'interrupted');
    assert.equal(test.engine.executionPhase(test.room, test.task, calls[1]!), 'settled');
    assert.equal(calls.length, 2); assert.equal(test.context().usage.ordinary, 2); assert.equal(test.context().usage.checks, 0);
  }
  close() { this.test.close(); }
}
export async function lateAttemptRace(backend = 'Memory') {
  const race = new LateAttemptRace(backend); try { await race.finish(); } finally { race.close(); }
}
