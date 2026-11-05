import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { MemoryStore, SqliteStore, type Store } from '../src/store.js';
import { WorkRunner } from '../src/runner.js';
import { restoreTask } from '../src/task.machine.js';
import { currentExecutionVersion, currentToolVersion } from '../src/task/protocol.js';
import type { Intent, TaskContext } from '../src/types.js';
import { legacyTaskContract } from './task-model-contract.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';

/** Keep the frozen assistance handoff data and exercise recovery within the current protocol. */
function currentRecoverySeed() {
  const saved = structuredClone(legacyTaskContract.savedResult) as { context: TaskContext };
  Object.assign(saved.context.config, { version: currentExecutionVersion, toolVersion: currentToolVersion });
  saved.context.deliveryCycle = { requests: 0, revisionUsed: false };
  return saved;
}

/** Real storage and runner; only the external adapter is controlled. */
export class SavedTaskRecovery {
  readonly room = 'legacy-model-room';
  readonly saved = currentRecoverySeed();
  readonly original = restoreTask(this.saved).context;
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-model-recovery-'));
  store: Store;
  engine: TeamEngine;
  calls: Intent[] = [];
  constructor(readonly storage: string) {
    assert(['Memory', 'SQLite'].includes(storage));
    this.store = this.openStore();
    this.store.transact(this.room, tx => {
      tx.room.activeTaskId = this.original.taskId;
      tx.room.tasks[this.original.taskId] = { version: 3, snapshot: this.saved };
    });
    this.engine = this.openEngine();
    assert.deepEqual(this.engine.view(this.room)!.context, this.original);
  }
  private openStore() { return this.storage === 'SQLite' ? new SqliteStore(join(this.directory, 'team.sqlite')) : new MemoryStore(); }
  private openEngine() { return new TeamEngine(this.store, structuredClone(this.original.config), () => 50); }
  context() { return this.engine.view(this.room, this.original.taskId)!.context; }
  private runner() {
    return new WorkRunner(this.engine, { execute: async work => {
      // The adapter observes the committed claim, not merely an in-memory work argument.
      const current = this.context(), stored = current.intents.find(intent => intent.id === work.id)!;
      assert.equal(stored.status, 'inflight'); assert.equal(stored.attempt, work.attempt);
      assert.equal(stored.requestCount, 1);
      this.calls.push(structuredClone(work));
      if (work.kind === 'check') { assert.equal(current.usage.checks, this.original.usage.checks + 1); return fixtureCheck(work.payload.candidate); }
      assert.equal(work.kind, 'owner'); assert.equal(work.payload.resultId, this.original.results[0]!.resultId);
      assert.equal(current.usage.ordinary, this.original.usage.ordinary + 1);
      return { type: 'deliver', text: '负责人依据已保存的核查结果完成方案', artifactIds: [] };
    } }, () => 50);
  }
  async resume() {
    if (this.storage === 'SQLite') { this.store.close(); this.store = this.openStore(); }
    this.engine = this.openEngine();
    assert(this.engine.send(this.room, this.original.taskId, { type: 'RECOVER', id: 'legacy:recover', at: 50, config: this.original.config }).ok);
    assert(await this.runner().runOne(this.room, this.original.taskId)); // Flush the saved result first.
    assert.equal(this.calls.length, 0);
  }
  assertHandoff() {
    const current = this.context(), result = this.original.results[0]!;
    assert.deepEqual(current.goal, this.original.goal); assert.equal(current.taskId, this.original.taskId);
    assert.deepEqual(current.usage, this.original.usage);
    assert.deepEqual(current.results[0], { ...result, consumed: true });
    assert.deepEqual(current.consumedResults, [result.resultId]);
    assert.equal(current.intents.filter(work => work.payload.resultId === result.resultId).length, 1);
    assert.equal(current.messages.filter(message => message.kind === 'answer' && message.requestId === result.requestId).length, 1);
  }
  async repeatAndComplete() {
    this.assertHandoff();
    for (let n = 0; n < 3; n++) { this.engine = this.openEngine(); this.engine.recover(this.room); this.assertHandoff(); }
    assert.equal(this.calls.length, 0);
    const runner = this.runner();
    assert(await runner.runOne(this.room, this.original.taskId));
    assert(await runner.runOne(this.room, this.original.taskId));
    assert.equal(await runner.runOne(this.room, this.original.taskId), false);
    assert.equal(this.context().outcome, 'complete');
    this.engine = this.openEngine(); this.engine.recover(this.room);
    assert.equal(await this.runner().runOne(this.room, this.original.taskId), false);
    assert.deepEqual(this.calls.map(work => work.kind), ['owner', 'check']);
    const c = this.context(), result = this.original.results[0]!;
    assert.equal(c.intents.filter(work => work.payload.resultId === result.resultId).length, 1);
    assert.equal(c.messages.filter(message => message.kind === 'answer' && message.requestId === result.requestId).length, 1);
    assert.deepEqual(c.usage, { ...this.original.usage, ordinary: this.original.usage.ordinary + 1, checks: this.original.usage.checks + 1 });
  }
  close() { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
}
