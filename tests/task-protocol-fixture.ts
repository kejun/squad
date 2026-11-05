import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import type { LocalOperation } from '../src/local-operation.js';
import { LocalRuntime, type LocalExecution } from '../src/local-runtime.js';
import { SqliteStore } from '../src/store.js';
import { WorkRunner } from '../src/runner.js';
import { restoreTask } from '../src/task.machine.js';
import { createTeamConfig } from '../team.config.js';
import { legacyTaskSnapshot } from './legacy-task-snapshot-fixture.js';
import { ControlledProcessBackend } from './local-tools-fixture.js';

export class TaskProtocolFixture {
  readonly room = 'protocol-fixture';
  readonly task = 'task:legacy';
  readonly backend = new ControlledProcessBackend();
  readonly legacyConfig = { ...createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'false' }), version: 'team-v2', toolVersion: 'tools-v2' };
  readonly currentConfig = { ...createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'false' }),
    models: { default: 'current', services: { current: { baseUrl: 'https://current.example', model: 'current-model' } } } };
  readonly dbPath: string;
  store: SqliteStore;
  engine: TeamEngine;
  runtime!: LocalRuntime;
  op!: LocalOperation;
  completion!: LocalExecution;
  modelCalls = 0;
  private constructor(readonly root: string) {
    this.dbPath = join(root, 'squad.sqlite');
    this.store = new SqliteStore(this.dbPath);
    this.engine = new TeamEngine(this.store, this.legacyConfig, () => 0);
  }
  static async create(terminal: boolean) {
    const fixture = new TaskProtocolFixture(await mkdtemp(join(tmpdir(), 'squad-protocol-')));
    try {
      const source = join(fixture.root, 'source');
      await mkdir(source);
      fixture.runtime = await LocalRuntime.create({ dataRoot: join(fixture.root, 'runtime'), workspaceRoot: source, backend: fixture.backend, clock: () => 0 });
      await fixture.prepare(terminal);
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }
  private async prepare(terminal: boolean) {
    assert(this.engine.submit(this.room, { id: 'legacy', text: '原任务' }).ok);
    const work = this.engine.pending(this.room, this.task)[0]!;
    const claimed = this.engine.claim(this.room, this.task, work.id)!;
    assert(this.engine.beginExecution(this.room, this.task, claimed));
    const operation = this.engine.requestLocal(this.room, this.task, work.id, claimed.attempt,
      { type: 'runCli', executable: 'node', args: ['-e', "process.stdout.write('旧回执');process.exitCode=7"] },
      [], this.runtime.workspaceId(claimed, this.engine.localNamespace(this.room, this.task)));
    this.op = this.engine.claimLocal(this.room, this.task, work.id, operation.id, claimed.attempt).operation!;
    this.completion = await this.runtime.execute(claimed, this.op, new AbortController().signal, metadata => {
      assert(this.engine.send(this.room, this.task, { type: 'LOCAL_STARTED', id: 'legacy:process-started', at: 1,
        intentId: work.id, operationId: operation.id, sessionId: this.op.sessionId!, ...metadata }).ok);
    });
    assert(this.completion.settled && this.completion.effectsKnown);
    if (!terminal) { this.saveLegacySnapshot(false); return; }
    assert(this.engine.send(this.room, this.task, { type: 'LOCAL_RESULT', id: 'legacy:process-result', at: 2,
      intentId: work.id, operationId: operation.id, sessionId: this.op.sessionId!, ...this.completion }).ok);
    assert(this.engine.send(this.room, this.task, { type: 'STOP', id: 'legacy:stop', at: 3 }).ok);
    assert(this.engine.send(this.room, this.task, { type: 'SETTLE', id: 'legacy:settled', at: 4, intentId: work.id }).ok);
    assert.equal(this.view().phase, 'ended');
    this.saveLegacySnapshot(true);
    assert.equal(this.view().context.outcome, 'complete');
  }
  private saveLegacySnapshot(terminal: boolean) {
    this.store.transact(this.room, tx => {
      const record = tx.room.tasks[this.task] as { version: number; snapshot: unknown };
      tx.room.tasks[this.task] = { ...record, snapshot: legacyTaskSnapshot(restoreTask(record.snapshot), terminal) };
    });
  }
  view() { return this.engine.view(this.room, this.task)!; }
  get saved() { return this.store.read(this.room).tasks[this.task] as { version: number; snapshot: unknown }; }
  get persistedOp() { return this.view().context.intents.flatMap(work => work.localOperations ?? []).find(op => op.id === this.op.id)!; }
  upgrade() {
    this.store.close();
    this.store = new SqliteStore(this.dbPath);
    this.engine = new TeamEngine(this.store, this.currentConfig, () => 50);
    this.engine.recover(this.room);
  }
  async reconcile() {
    const result = await this.runtime.reconcile(this.persistedOp);
    assert(result?.resolution === 'receipt');
    const work = this.view().context.intents.find(intent => intent.localOperations?.some(op => op.id === this.op.id))!;
    const reply = this.engine.send(this.room, this.task, { type: 'LOCAL_RECONCILE', id: 'upgraded:receipt', at: 51,
      intentId: work.id, operationId: this.op.id, sessionId: this.op.sessionId!, ...result });
    assert(reply.ok);
  }
  async tryRun() {
    const runner = new WorkRunner(this.engine, { execute: async () => { this.modelCalls++; return { type: 'settled' }; } }, () => 51);
    return runner.runOne(this.room, this.task);
  }
  attemptLegacyModelRequest() {
    const work = this.view().context.intents.find(intent => intent.localOperations?.some(op => op.id === this.op.id))!;
    return this.engine.send(this.room, this.task, { type: 'CONSUME', id: 'upgraded:late-request', at: 51,
      intentId: work.id, fence: work });
  }
  continue(route: string) {
    if (route === '继续任务') return this.engine.submit(this.room, { id: 'continue-current', text: '继续', intent: 'continue', replyToTaskId: this.task });
    const source = this.view().context.intents.find(work => work.localOperations?.some(op => op.id === this.op.id))!;
    return this.engine.requestHostRetry(this.room, this.task, source.id, this.op.id, this.op.requestHash, 'retry-current');
  }
  async close() {
    await this.runtime?.close();
    this.store.close();
    await rm(this.root, { recursive: true, force: true });
  }
}
